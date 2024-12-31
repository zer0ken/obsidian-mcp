import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Normalizes and resolves a path consistently
 * @param inputPath - The path to normalize
 * @returns The normalized and resolved absolute path
 * @throws {McpError} If the input path is empty or invalid
 */
export function normalizePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid path: ${inputPath}`
    );
  }
  
  try {
    const normalized = path.normalize(inputPath);
    return path.resolve(normalized);
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Failed to normalize path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Checks if a target path is safely contained within a base path
 * @param basePath - The base directory path
 * @param targetPath - The target path to check
 * @returns True if target is within base path, false otherwise
 */
export function checkPathSafety(basePath: string, targetPath: string): boolean {
  const resolvedPath = normalizePath(targetPath);
  const resolvedBasePath = normalizePath(basePath);
  return resolvedPath.startsWith(resolvedBasePath);
}

/**
 * Ensures a path has .md extension and is valid
 * @param filePath - The file path to check
 * @returns The path with .md extension
 * @throws {McpError} If the path is invalid
 */
export function ensureMarkdownExtension(filePath: string): string {
  const normalized = normalizePath(filePath);
  return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

/**
 * Validates that a path is within the vault directory
 * @param vaultPath - The vault directory path
 * @param targetPath - The target path to validate
 * @throws {McpError} If path is outside vault or invalid
 */
export function validateVaultPath(vaultPath: string, targetPath: string): void {
  if (!checkPathSafety(vaultPath, targetPath)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Path must be within the vault directory. Path: ${targetPath}, Vault: ${vaultPath}`
    );
  }
}

/**
 * Safely joins paths and ensures result is within vault
 * @param vaultPath - The vault directory path
 * @param segments - Path segments to join
 * @returns The joined and validated path
 * @throws {McpError} If resulting path would be outside vault
 */
export function safeJoinPath(vaultPath: string, ...segments: string[]): string {
  const joined = path.join(vaultPath, ...segments);
  const resolved = normalizePath(joined);
  
  validateVaultPath(vaultPath, resolved);
  
  return resolved;
}
