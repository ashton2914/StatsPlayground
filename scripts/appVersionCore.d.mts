export type GitRunner = (args: string[]) => string;

export declare function resolveAppVersion(executeGit?: GitRunner): string;