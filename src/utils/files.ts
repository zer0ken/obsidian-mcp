import { promises as fs } from "fs";
import path from "path";
import { checkPathSafety } from "./path.js";

/**
 * Recursively gets all markdown files in a directory
 */
export async function getAllMarkdownFiles(vaultPath: string, dir = vaultPath): Promise<string[]> {
  try {
    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // First check if the path is safe
      if (!await checkPathSafety(vaultPath, fullPath)) {
        console.error(`Skipping path outside vault: ${fullPath}`);
        continue;
      }

      try {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          files.push(...await getAllMarkdownFiles(vaultPath, fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      } catch (err) {
        console.error(`Error processing ${fullPath}:`, err);
        // Continue with other files
      }
    }

    return files;
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err);
    return [];
  }
}

/**
 * Ensures a directory exists, creating it if necessary
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely reads a file's contents
 * Returns undefined if file doesn't exist
 */
export async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
