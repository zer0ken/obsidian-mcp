import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";

export const SearchSchema = z.object({
  query: z.string(),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional()
});

async function getAllMarkdownFiles(vaultPath: string, dir = vaultPath): Promise<string[]> {
  let files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files = files.concat(await getAllMarkdownFiles(vaultPath, fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function searchVault(vaultPath: string, query: string, searchPath?: string, caseSensitive = false): Promise<Array<{file: string, matches: Array<{line: number, text: string}>}>> {
  const files = await getAllMarkdownFiles(vaultPath, searchPath ? path.join(vaultPath, searchPath) : undefined);
  const results: Array<{file: string, matches: Array<{line: number, text: string}>}> = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");
    const matches: Array<{line: number, text: string}> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (caseSensitive ? line.includes(query) : line.toLowerCase().includes(query.toLowerCase())) {
        matches.push({
          line: i + 1,
          text: line.trim()
        });
      }
    }

    if (matches.length > 0) {
      results.push({
        file: path.relative(vaultPath, file),
        matches
      });
    }
  }

  return results;
}

function formatSearchResults(results: Array<{file: string, matches: Array<{line: number, text: string}>}>): string {
  if (results.length === 0) {
    return "No matches found";
  }

  return results.map(result => {
    const matchText = result.matches
      .map(m => `  Line ${m.line}: ${m.text}`)
      .join("\n");
    return `${result.file}:\n${matchText}`;
  }).join("\n\n");
}

export function createSearchVaultTool(vaultPath: string): Tool {
  return {
    name: "search-vault",
    description: "Search for text across notes",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query"
        },
        path: {
          type: "string",
          description: "Optional path to limit search scope"
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether to perform case-sensitive search"
        }
      },
      required: ["query"]
    },
    handler: async (args) => {
      const { query, path: searchPath, caseSensitive } = SearchSchema.parse(args);
      const results = await searchVault(vaultPath, query, searchPath, caseSensitive);
      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(results)
          }
        ]
      };
    }
  };
}
