import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { getAllMarkdownFiles } from "../../utils/files.js";
import { handleFsError, handleZodError } from "../../utils/errors.js";
import { extractTags, normalizeTag, matchesTagPattern } from "../../utils/tags.js";

// Improved schema with better validation
export const SearchSchema = z.object({
  query: z.string().min(1, "Search query cannot be empty"),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional().default(false),
  searchType: z.enum(['content', 'filename', 'both']).optional().default('content')
});

type SearchResult = {
  file: string;
  matches: Array<{
    line: number;
    text: string;
  }>;
};

function isTagSearch(query: string): boolean {
  return query.startsWith('tag:');
}

function normalizeTagQuery(query: string): string {
  // Remove 'tag:' prefix
  return normalizeTag(query.slice(4));
}

async function searchFilenames(
  vaultPath: string,
  query: string,
  searchPath?: string,
  caseSensitive = false
): Promise<SearchResult[]> {
  const searchDir = searchPath ? path.join(vaultPath, searchPath) : vaultPath;
  validateVaultPath(vaultPath, searchDir);

  const files = await getAllMarkdownFiles(vaultPath, searchDir);
  const results: SearchResult[] = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (const file of files) {
    const relativePath = path.relative(vaultPath, file);
    const searchTarget = caseSensitive ? relativePath : relativePath.toLowerCase();

    if (searchTarget.includes(searchQuery)) {
      results.push({
        file: relativePath,
        matches: [{
          line: 0, // We use 0 to indicate this is a filename match
          text: `Filename match: ${relativePath}`
        }]
      });
    }
  }

  return results;
}

async function searchContent(
  vaultPath: string,
  query: string,
  searchPath?: string,
  caseSensitive = false
): Promise<SearchResult[]> {
  const searchDir = searchPath ? path.join(vaultPath, searchPath) : vaultPath;
  validateVaultPath(vaultPath, searchDir);

  const files = await getAllMarkdownFiles(vaultPath, searchDir);
  const results: SearchResult[] = [];
  const isTagSearchQuery = isTagSearch(query);
  const normalizedTagQuery = isTagSearchQuery ? normalizeTagQuery(query) : '';

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf-8");
      const lines = content.split("\n");
      const matches: SearchResult["matches"] = [];

      if (isTagSearchQuery) {
        // For tag searches, extract all tags from the content
        const fileTags = extractTags(content);
        
        lines.forEach((line, index) => {
          // Look for tag matches in each line
          const lineTags = extractTags(line);
          const hasMatchingTag = lineTags.some(tag => {
            const normalizedTag = normalizeTag(tag);
            return normalizedTag === normalizedTagQuery || matchesTagPattern(normalizedTagQuery, normalizedTag);
          });

          if (hasMatchingTag) {
            matches.push({
              line: index + 1,
              text: line.trim()
            });
          }
        });
      } else {
        // Regular text search
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        
        lines.forEach((line, index) => {
          const searchLine = caseSensitive ? line : line.toLowerCase();
          if (searchLine.includes(searchQuery)) {
            matches.push({
              line: index + 1,
              text: line.trim()
            });
          }
        });
      }

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
}

async function searchVault(
  vaultPath: string,
  query: string,
  searchPath?: string,
  caseSensitive = false,
  searchType: 'content' | 'filename' | 'both' = 'content'
): Promise<SearchResult[]> {
  try {
    let results: SearchResult[] = [];

    if (searchType === 'filename' || searchType === 'both') {
      const filenameResults = await searchFilenames(vaultPath, query, searchPath, caseSensitive);
      results = results.concat(filenameResults);
    }

    if (searchType === 'content' || searchType === 'both') {
      const contentResults = await searchContent(vaultPath, query, searchPath, caseSensitive);
      results = results.concat(contentResults);
    }

    return results;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'search vault');
  }
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  const filenameMatches = results.filter(r => r.matches.some(m => m.line === 0));
  const contentMatches = results.filter(r => r.matches.some(m => m.line !== 0));
  
  const parts: string[] = [];
  
  // Add summary
  const totalMatches = results.reduce((sum, result) => sum + result.matches.length, 0);
  parts.push(`Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}:`);
  
  // Add filename matches if any
  if (filenameMatches.length > 0) {
    parts.push('\nFilename matches:');
    filenameMatches.forEach(result => {
      parts.push(`  ${result.file}`);
    });
  }
  
  // Add content matches if any
  if (contentMatches.length > 0) {
    parts.push('\nContent matches:');
    contentMatches.forEach(result => {
      parts.push(`\nFile: ${result.file}`);
      result.matches
        .filter(m => m.line !== 0) // Skip filename matches
        .forEach(m => parts.push(`  Line ${m.line}: ${m.text}`));
    });
  }
  
  return parts.join('\n');
}

export function createSearchVaultTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "search-vault",
    description: `Search for text or tags across markdown notes in the vault.

Examples:
- Content search: { "query": "hello world", "searchType": "content" }
- Filename search: { "query": "meeting-notes", "searchType": "filename" }
- Search both: { "query": "project", "searchType": "both" }
- Tag search: { "query": "tag:status/active" }
- Search in subfolder: { "query": "hello", "path": "journal/2024" }
- INCORRECT: { "query": "#status/active" } (use tag: prefix, not #)
- INCORRECT: { "query": "status/active" } (missing tag: prefix for tag search)`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (required). For text search use the term directly, for tag search use tag: prefix"
        },
        path: {
          type: "string",
          description: "Optional subfolder path within the vault to limit search scope"
        },
        caseSensitive: {
          type: "boolean",
          description: "Whether to perform case-sensitive search (default: false)"
        },
        searchType: {
          type: "string",
          enum: ["content", "filename", "both"],
          description: "Type of search to perform (default: content)"
        }
      },
      required: ["query"]
    },
    handler: async (args) => {
      try {
        const { query, path: searchPath, caseSensitive, searchType } = SearchSchema.parse(args);
        const results = await searchVault(vaultPath, query, searchPath, caseSensitive, searchType);
        
        return {
          content: [{
            type: "text",
            text: formatSearchResults(results)
          }]
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          handleZodError(error);
        }
        throw error;
      }
    }
  };
}
