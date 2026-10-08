import { execute } from "./process.ts";
import type { GitHubGateway, PrInput } from "./types.ts";
type Executor = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<string>;
export class GitHub implements GitHubGateway {
  constructor(private readonly exec: Executor = execute) {}
  async identity(): Promise<string> {
    return (
      await this.exec("gh", [
        "api",
        "user",
        "--jq",
        ".login",
        "--hostname",
        "github.com",
      ])
    ).trim();
  }
  async find(repository: string, head: string): Promise<string | null> {
    const prs = JSON.parse(
      await this.exec("gh", [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        head,
        "--state",
        "open",
        "--json",
        "url",
      ]),
    );
    if (!Array.isArray(prs) || prs.length > 1)
      throw new Error("Ambiguous existing pull requests.");
    return prs[0]?.url ?? null;
  }
  async push(cwd: string, branch: string): Promise<void> {
    await this.exec(
      "git",
      ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
      cwd,
    );
  }
  async create(input: PrInput): Promise<string> {
    const url = (
      await this.exec("gh", [
        "pr",
        "create",
        "--repo",
        input.repository,
        "--base",
        input.base,
        "--head",
        input.head,
        "--draft",
        "--title",
        input.title,
        "--body-file",
        input.bodyFile,
      ])
    ).trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url))
      throw new Error(
        "GitHub returned an invalid PR URL; retry to recover the existing PR.",
      );
    return url;
  }
}
