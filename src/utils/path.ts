import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Normalizes and resolves a path consistently
 */
export function normalizePath(inputPath: string): string {
  // First normalize to handle .. and . segments
  const normalized = path.normalize(inputPath);
  // Then resolve to absolute path
  return path.resolve(normalized);
}

/**
 * Checks if a target path is safely contained within a base path
 */
export async function checkPathSafety(basePath: string, targetPath: string): Promise<boolean> {
  const resolvedPath = normalizePath(targetPath);
  const resolvedBasePath = normalizePath(basePath);
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
 * @throws {McpError} If path is outside vault or invalid
 */
export function validateVaultPath(vaultPath: string, targetPath: string): void {
  try {
    const resolvedTarget = normalizePath(targetPath);
    const resolvedBase = normalizePath(vaultPath);
    
    if (!resolvedTarget.startsWith(resolvedBase)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Path must be within the vault directory. Path: ${targetPath}, Vault: ${vaultPath}`
      );
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Safely joins paths and ensures result is within vault
 */
export function safeJoinPath(vaultPath: string, ...segments: string[]): string {
  const joined = path.join(vaultPath, ...segments);
  const resolved = normalizePath(joined);
  const resolvedBase = normalizePath(vaultPath);
  
  if (!resolved.startsWith(resolvedBase)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Resulting path would be outside vault: ${joined}`
    );
  }
  
  return resolved;
}
