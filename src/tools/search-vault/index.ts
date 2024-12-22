import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";

// Improved schema with better validation
export const SearchSchema = z.object({
  query: z.string().min(1, "Search query cannot be empty"),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional().default(false)
});

type SearchResult = {
  file: string;
  matches: Array<{
    line: number;
    text: string;
  }>;
};

async function checkPathSafety(basePath: string, targetPath: string): Promise<boolean> {
  const resolvedPath = path.resolve(targetPath);
  const resolvedBasePath = path.resolve(basePath);
  return resolvedPath.startsWith(resolvedBasePath);
}

async function getAllMarkdownFiles(vaultPath: string, dir = vaultPath): Promise<string[]> {
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

async function searchVault(
  vaultPath: string,
  query: string,
  searchPath?: string,
  caseSensitive = false
): Promise<SearchResult[]> {
  try {
    const searchDir = searchPath ? path.join(vaultPath, searchPath) : vaultPath;
    
    // Validate the search directory is within vault
    if (!await checkPathSafety(vaultPath, searchDir)) {
      throw new Error("Search path is outside the vault directory");
    }

    const files = await getAllMarkdownFiles(vaultPath, searchDir);
    const results: SearchResult[] = [];
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n");
        const matches: SearchResult["matches"] = [];

        lines.forEach((line, index) => {
          const searchLine = caseSensitive ? line : line.toLowerCase();
          if (searchLine.includes(searchQuery)) {
            matches.push({
              line: index + 1,
              text: line.trim()
            });
          }
        });

        if (matches.length > 0) {
          results.push({
            file: path.relative(vaultPath, file),
            matches
          });
        }
      } catch (err) {
        console.error(`Error reading file ${file}:`, err);
        // Continue with other files
      }
    }

    return results;
  } catch (err) {
    console.error("Error in searchVault:", err);
    throw new Error(`Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  const totalMatches = results.reduce((sum, result) => sum + result.matches.length, 0);
  const header = `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}:\n\n`;

  const formattedResults = results.map(result => {
    const matchText = result.matches
      .map(m => `  Line ${m.line}: ${m.text}`)
      .join("\n");
    return `File: ${result.file}\n${matchText}`;
  }).join("\n\n");

  return header + formattedResults;
}

export function createSearchVaultTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  // Validate vault path exists and is accessible
  try {
    fs.access(vaultPath);
  } catch (err) {
    throw new Error(`Invalid vault path: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  return {
    name: "search-vault",
    description: "Search for text across markdown notes in the vault",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (required)"
        },
        path: {
          type: "string",
          description: "Optional subfolder path within the vault to limit search scope"
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether to perform case-sensitive search (default: false)"
        }
      },
      required: ["query"]
    },
    handler: async (args) => {
      try {
        const { query, path: searchPath, caseSensitive } = SearchSchema.parse(args);
        const results = await searchVault(vaultPath, query, searchPath, caseSensitive);
        
        return {
          content: [{
            type: "text",
            text: formatSearchResults(results)
          }]
        };
      } catch (err) {
        // Proper error handling for MCP tool response
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : 'An unknown error occurred'}`
          }]
        };
      }
    }
  };
}