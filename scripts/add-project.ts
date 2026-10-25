import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import * as yaml from "js-yaml";
import { MAX_LINKS, REGISTRY_DOMAINS, REPO_RE, resolveGitHubToken } from "./validate.ts";

type GitHubRepo = { full_name: string; private: boolean; homepage: string | null };
type GitHubUser = { login: string };

type Project = {
  repo: string;
  submittedBy: string;
  banner?: string;
  website?: string;
  links?: string[];
};

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const SKIP = "-";

const bold = (s: string) => styleText("bold", s);
const dim = (s: string) => styleText("dim", s);
const red = (s: string) => styleText("red", s);
const green = (s: string) => styleText("green", s);
const cyan = (s: string) => styleText("cyan", s);
const yellow = (s: string) => styleText("yellow", s);

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => {
  console.log(`\n${dim("Cancelled.")}`);
  process.exit(130);
});

const token = resolveGitHubToken();

/** GET a GitHub API path; `null` on 404, throws on any other failure. */
async function githubGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      "User-Agent": "AzGitCommunity-Showcase",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let message = `GitHub API error: ${res.status} ${res.statusText}`;
    const reset = res.headers.get("x-ratelimit-reset");
    if ((res.status === 403 || res.status === 429) && reset) {
      message += ` (rate limit resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()})`;
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** Run a lookup after a "Checking..." line: `null` = not found, `undefined` = couldn't check (offline, rate limit). */
async function lookup<T>(fn: () => Promise<T | null>, what: string): Promise<T | null | undefined> {
  try {
    const result = await fn();
    console.log(result ? ` ${green("✓")}` : "");
    return result;
  } catch (err) {
    console.log(
      `\n  ${yellow(`Could not verify the ${what} on GitHub, continuing anyway. ${(err as Error).message}`)}`,
    );
    return undefined;
  }
}

/** Ask until `parse` accepts the answer; `parse` throws to reject it with a message. */
async function prompt<T>(question: string, parse: (input: string) => T | Promise<T>, hint?: string): Promise<T> {
  while (true) {
    const label = `${bold(cyan(question))}${hint ? ` ${dim(`(${hint})`)}` : ""}${bold(cyan(":"))} `;
    const input = (await rl.question(label)).trim();
    try {
      return await parse(input);
    } catch (err) {
      console.log(`  ${red(err instanceof Error ? err.message : String(err))}\n`);
    }
  }
}

/** Returns `input` unchanged if it is an HTTPS URL, throws otherwise. */
function checkHttpsUrl(input: string, field: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`\`${input}\` is not a valid URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`The ${field} must use HTTPS.`);
  return input;
}

/** The hostname of `url` if it is a known package registry, otherwise `undefined`. */
function registryHost(url: string): string | undefined {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  return REGISTRY_DOMAINS.has(hostname) ? hostname : undefined;
}

/** Map of lowercased `owner/repo` → filename for every existing submission. */
function existingRepos(): Map<string, string> {
  const repos = new Map<string, string>();
  for (const file of readdirSync("projects").filter((f) => f.endsWith(".yaml"))) {
    try {
      const data = yaml.load(readFileSync(join("projects", file), "utf8"), { schema: yaml.JSON_SCHEMA }) as {
        repo?: string;
      } | null;
      if (data?.repo) repos.set(data.repo.toLowerCase(), file);
    } catch {
      // Unparseable files are reported by `pnpm check`.
    }
  }
  return repos;
}

async function askRepo(): Promise<{ repo: string; homepage: string | null }> {
  const existing = existingRepos();

  return prompt(
    "GitHub repository",
    async (input) => {
      let repo = input
        .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
        .replace(/\/+$/, "")
        .replace(/\.git$/, "");
      if (!REPO_RE.test(repo)) throw new Error("Enter the repository as owner/repo or a github.com URL.");

      process.stdout.write(dim("  Checking GitHub..."));
      const data = await lookup(() => githubGet<GitHubRepo>(`/repos/${repo}`), "repo");
      if (data === null) throw new Error(`Repository \`${repo}\` does not exist or is not public.`);
      if (data?.private) throw new Error(`Repository \`${repo}\` is private, only public repos are allowed.`);
      if (data && data.full_name !== repo) console.log(dim(`  Using canonical name ${data.full_name}`));
      repo = data?.full_name ?? repo;

      const duplicate = existing.get(repo.toLowerCase());
      if (duplicate) throw new Error(`\`${repo}\` is already in the showcase (projects/${duplicate}).`);
      return { repo, homepage: data?.homepage ?? null };
    },
    "owner/repo or GitHub URL",
  );
}

/** Login of the user signed in to the GitHub CLI, or a setup hint when it's missing or signed out. */
function ghLogin(): { login?: string; hint?: string } {
  const res = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
  const login = res.status === 0 ? res.stdout.trim() : "";
  if (login) return { login };

  const benefit = "to auto-fill your username and avoid GitHub API rate limits.";
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { hint: `Tip: install the GitHub CLI (https://cli.github.com) and run \`gh auth login\` ${benefit}` };
  }
  // gh exits with 4 when not authenticated; other failures (e.g. offline) get no hint.
  if (res.status === 4) return { hint: `Tip: run \`gh auth login\` ${benefit}` };
  return {};
}

async function askSubmittedBy(fallback: string | undefined): Promise<string> {
  return prompt(
    "Your GitHub username",
    async (input) => {
      const username = (input || fallback || "").replace(/^@/, "");
      if (!username) throw new Error("Username cannot be empty.");
      if (username === fallback) return username;
      if (!USERNAME_RE.test(username)) throw new Error(`\`${username}\` is not a valid GitHub username.`);
      process.stdout.write(dim("  Checking GitHub..."));
      const user = await lookup(() => githubGet<GitHubUser>(`/users/${username}`), "user");
      if (user === null) throw new Error(`User \`${username}\` not found on GitHub.`);
      return user?.login ?? username;
    },
    fallback ? `Enter for ${fallback}` : undefined,
  );
}

async function askBanner(): Promise<string | undefined> {
  return prompt(
    "Banner image URL",
    (input) => (input ? checkHttpsUrl(input, "banner") : undefined),
    "optional, HTTPS, 1280×640 recommended, Enter to skip",
  );
}

async function askWebsite(homepage: string | null): Promise<string | undefined> {
  let fallback: string | undefined;
  try {
    if (homepage && !registryHost(checkHttpsUrl(homepage, "website"))) fallback = homepage;
  } catch {
    // Repo homepage isn't usable as a default.
  }

  return prompt(
    "Project website",
    (input) => {
      if (input === SKIP || (!input && !fallback)) return undefined;
      const url = checkHttpsUrl(input || fallback!, "website");
      const registry = registryHost(url);
      if (registry) throw new Error(`\`${registry}\` is a package registry, add it under links instead.`);
      return url;
    },
    fallback ? `Enter for ${fallback}, ${SKIP} to skip` : "optional, own site or docs, Enter to skip",
  );
}

async function askLinks(website: string | undefined): Promise<string[]> {
  console.log(dim("  Package registry / marketplace URLs (npm, PyPI, VS Code Marketplace, ...)."));
  const links: string[] = [];
  while (links.length < MAX_LINKS) {
    const link = await prompt(
      `Link ${links.length + 1}/${MAX_LINKS}`,
      (input) => {
        if (!input) return undefined;
        const url = checkHttpsUrl(input, "link");
        if (url === website) throw new Error("This URL is already set as the website.");
        if (links.includes(url)) throw new Error("This link is already added.");
        return url;
      },
      links.length === 0 ? "optional, Enter to skip" : "Enter to finish",
    );
    if (!link) break;
    links.push(link);
  }
  return links;
}

async function main() {
  console.log(`\n${bold(cyan("Add a project to the showcase"))}`);
  console.log(dim("Press Ctrl+C at any time to cancel.\n"));

  const { login, hint } = ghLogin();
  if (hint) console.log(`${yellow(hint)}\n`);

  const { repo, homepage } = await askRepo();
  const submittedBy = await askSubmittedBy(login);
  const banner = await askBanner();
  const website = await askWebsite(homepage);
  const links = await askLinks(website);

  const project: Project = { repo, submittedBy };
  if (banner) project.banner = banner;
  if (website) project.website = website;
  if (links.length > 0) project.links = links;

  const [owner, name] = repo.split("/");
  const file = join("projects", `${owner}-${name}.yaml`).replaceAll("\\", "/");
  const content = yaml.dump(project, { forceQuotes: true, quoteStyle: "double", lineWidth: -1 });

  console.log(`\n${bold(file)}\n${dim("─".repeat(40))}\n${content}${dim("─".repeat(40))}`);

  const action = existsSync(file) ? "overwrite the existing file" : "create the file";
  await rl.question(`${bold(cyan(`Press Enter to ${action}`))} ${dim("(Ctrl+C to cancel)")} `);

  writeFileSync(file, content);
  console.log(`\n${green("✓")} Created ${bold(file)}\n`);
  console.log(bold("Next steps:"));
  console.log(`  1. Run ${cyan("pnpm check")} and fix any reported errors`);
  console.log(`  2. Commit the file and push it to your fork`);
  console.log(`  3. Open a pull request titled ${cyan(`add: ${repo}`)}`);
}

main()
  .catch((err) => {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  })
  .finally(() => rl.close());
