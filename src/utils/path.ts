import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Checks if a target path is safely contained within a base path
 */
export async function checkPathSafety(basePath: string, targetPath: string): Promise<boolean> {
  const resolvedPath = path.resolve(targetPath);
  const resolvedBasePath = path.resolve(basePath);
  return resolvedPath.startsWith(resolvedBasePath);
}

/**
 * Ensures a path has .md extension
 */
export function ensureMarkdownExtension(filePath: string): string {
  return filePath.endsWith('.md') ? filePath : `${filePath}.md`;
}

/**
 * Validates that a path is within the vault directory
 * @throws {McpError} If path is outside vault
 */
export function validateVaultPath(vaultPath: string, targetPath: string): void {
  const normalizedPath = path.normalize(targetPath);
  if (!normalizedPath.startsWith(path.normalize(vaultPath))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Path must be within the vault directory"
    );
  }
}
