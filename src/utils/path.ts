import path from "path";
import fs from "fs/promises";
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
    // Handle Windows paths
    let normalized = inputPath;

    // Validate paths for invalid characters in filename portion
    const filename = normalized.split(/[\\/]/).pop() || '';
    if (/[<>"|?*]/.test(filename)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Filename contains invalid characters: ${filename}`
      );
    }
    
    // Preserve UNC paths
    if (normalized.startsWith('\\\\')) {
      // Convert to forward slashes but preserve exactly two leading slashes
      normalized = '//' + normalized.slice(2).replace(/\\/g, '/');
      return normalized;
    }

    // Handle Windows drive letters
    if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
      // Normalize path while preserving drive letter
      normalized = path.normalize(normalized);
      // Convert to forward slashes for consistency
      normalized = normalized.replace(/\\/g, '/');
      return normalized;
    }

    // Validate path doesn't point to system directories
    const systemDirs = [
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\Users\\All Users',
      'C:\\Users\\Default',
      'C:\\Users\\Public'
    ];
    if (systemDirs.some(dir => normalized.startsWith(dir))) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Path points to system directory: ${normalized}`
      );
    }

    // Validate path isn't in home directory root
    if (normalized === '~' || normalized === 'C:\\Users\\' + process.env.USERNAME) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Path points to home directory root: ${normalized}`
      );
    }

    // Handle relative paths
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      normalized = path.normalize(normalized);
      return path.resolve(normalized);
    }

    // Default normalization for other paths
    normalized = normalized.replace(/\\/g, '/');
    if (normalized.startsWith('./') || normalized.startsWith('../')) {
      return path.resolve(normalized);
    }
    return normalized;
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
export async function checkPathSafety(basePath: string, targetPath: string): Promise<boolean> {
  const resolvedPath = normalizePath(targetPath);
  const resolvedBasePath = normalizePath(basePath);

  try {
    // Check real path for symlinks
    const realPath = await fs.realpath(resolvedPath);
    const normalizedReal = normalizePath(realPath);
    
    // Check if real path is within base path
    if (!normalizedReal.startsWith(resolvedBasePath)) {
      return false;
    }

    // Check if original path is within base path
    return resolvedPath.startsWith(resolvedBasePath);
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      return normalizedParent.startsWith(resolvedBasePath);
    } catch {
      return false;
    }
  }
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
