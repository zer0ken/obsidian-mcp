import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import { handleFsError, handleZodError } from "../../utils/errors.js";
import {
  validateTag,
  parseNote,
  stringifyNote,
  removeTagsFromFrontmatter,
  removeInlineTags,
  matchesTagPattern,
  isParentTag,
  getRelatedTags
} from "../../utils/tags.js";

// Schema for tag removal operations
const RemoveTagsSchema = z.object({
  files: z.array(z.string())
    .min(1, "At least one file must be specified")
    .refine(
      files => files.every(f => f.endsWith('.md')),
      "All files must have .md extension"
    ),
  tags: z.array(z.string())
    .min(1, "At least one tag must be specified")
    .refine(
      tags => tags.every(validateTag),
      "Invalid tag format. Tags must contain only letters, numbers, and forward slashes for hierarchy."
    ),
  options: z.object({
    location: z.enum(['frontmatter', 'content', 'both']).default('both'),
    normalize: z.boolean().default(true),
    preserveChildren: z.boolean().default(false),
    patterns: z.array(z.string()).default([])
  }).default({
    location: 'both',
    normalize: true,
    preserveChildren: false,
    patterns: []
  })
});

interface RemoveTagsReport {
  success: string[];
  errors: { file: string; error: string }[];
  details: {
    [filename: string]: {
      removedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
      preservedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
    };
  };
}

async function removeTags(
  vaultPath: string,
  params: z.infer<typeof RemoveTagsSchema>
): Promise<RemoveTagsReport> {
  const results: RemoveTagsReport = {
    success: [],
    errors: [],
    details: {}
  };

  for (const filename of params.files) {
    const fullPath = path.join(vaultPath, filename);
    
    try {
      // Validate path is within vault
      validateVaultPath(vaultPath, fullPath);
      
      // Check if file exists
      if (!await fileExists(fullPath)) {
        results.errors.push({
          file: filename,
          error: "File not found"
        });
        continue;
      }

      // Read file content
      const content = await safeReadFile(fullPath);
      if (!content) {
        results.errors.push({
          file: filename,
          error: "Failed to read file"
        });
        continue;
      }

      // Parse the note
      const parsed = parseNote(content);
      let modified = false;
      results.details[filename] = {
        removedTags: [],
        preservedTags: []
      };

      // Handle frontmatter tags
      if (params.options.location !== 'content') {
        const { frontmatter: updatedFrontmatter, report } = removeTagsFromFrontmatter(
          parsed.frontmatter,
          params.tags,
          {
            normalize: params.options.normalize,
            preserveChildren: params.options.preserveChildren,
            patterns: params.options.patterns
          }
        );
        
        results.details[filename].removedTags.push(...report.removed);
        results.details[filename].preservedTags.push(...report.preserved);
        
        if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
          parsed.frontmatter = updatedFrontmatter;
          modified = true;
        }
      }

      // Handle inline tags
      if (params.options.location !== 'frontmatter') {
        const { content: newContent, report } = removeInlineTags(
          parsed.content,
          params.tags,
          {
            normalize: params.options.normalize,
            preserveChildren: params.options.preserveChildren,
            patterns: params.options.patterns
          }
        );
        
        results.details[filename].removedTags.push(...report.removed);
        results.details[filename].preservedTags.push(...report.preserved);
        
        if (parsed.content !== newContent) {
          parsed.content = newContent;
          modified = true;
        }
      }

      // Save changes if modified
      if (modified) {
        const updatedContent = stringifyNote(parsed);
        await fs.writeFile(fullPath, updatedContent);
        results.success.push(filename);
      }
    } catch (error) {
      results.errors.push({
        file: filename,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return results;
}

export function createRemoveTagsTool(vaultPath: string): Tool {
  return {
    name: "remove-tags",
    description: "Remove tags from notes with support for hierarchical removal and patterns",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of note filenames to process"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Array of tags to remove"
        },
        options: {
          type: "object",
          properties: {
            location: {
              type: "string",
              enum: ["frontmatter", "content", "both"],
              description: "Where to remove tags from"
            },
            normalize: {
              type: "boolean",
              description: "Whether to normalize tag format (e.g., ProjectActive -> project-active)"
            },
            preserveChildren: {
              type: "boolean",
              description: "Whether to preserve child tags when removing parent tags"
            },
            patterns: {
              type: "array",
              items: { type: "string" },
              description: "Tag patterns to match for removal (supports * wildcard)"
            }
          }
        }
      },
      required: ["files", "tags"]
    },
    handler: async (args) => {
      try {
        // Parse and validate input
        const params = RemoveTagsSchema.parse(args);
        
        // Execute tag removal
        const results = await removeTags(vaultPath, params);
        
        // Format detailed response message
        let message = '';
        
        // Add success summary
        if (results.success.length > 0) {
          message += `Successfully processed tags in: ${results.success.join(', ')}\n\n`;
        }
        
        // Add detailed changes for each file
        for (const [filename, details] of Object.entries(results.details)) {
          if (details.removedTags.length > 0 || details.preservedTags.length > 0) {
            message += `Changes in ${filename}:\n`;
            
            if (details.removedTags.length > 0) {
              message += '  Removed tags:\n';
              const byLocation = details.removedTags.reduce((acc, change) => {
                if (!acc[change.location]) acc[change.location] = new Map();
                const key = change.line ? `${change.location} (line ${change.line})` : change.location;
                const locationMap = acc[change.location];
                if (locationMap) {
                  if (!locationMap.has(key)) {
                    locationMap.set(key, new Set());
                  }
                  const tagSet = locationMap.get(key);
                  if (tagSet) {
                    tagSet.add(change.tag);
                  }
                }
                return acc;
              }, {} as Record<string, Map<string, Set<string>>>);
              
              for (const [location, locationMap] of Object.entries(byLocation)) {
                for (const [key, tags] of locationMap.entries()) {
                  message += `    ${key}: ${Array.from(tags).join(', ')}\n`;
                }
              }
            }
            
            if (details.preservedTags.length > 0) {
              message += '  Preserved tags:\n';
              const byLocation = details.preservedTags.reduce((acc, change) => {
                if (!acc[change.location]) acc[change.location] = new Map();
                const key = change.line ? `${change.location} (line ${change.line})` : change.location;
                const locationMap = acc[change.location];
                if (locationMap) {
                  if (!locationMap.has(key)) {
                    locationMap.set(key, new Set());
                  }
                  const tagSet = locationMap.get(key);
                  if (tagSet) {
                    tagSet.add(change.tag);
                  }
                }
                return acc;
              }, {} as Record<string, Map<string, Set<string>>>);
              
              for (const [location, locationMap] of Object.entries(byLocation)) {
                for (const [key, tags] of locationMap.entries()) {
                  message += `    ${key}: ${Array.from(tags).join(', ')}\n`;
                }
              }
            }
            
            message += '\n';
          }
        }
        
        // Add errors if any
        if (results.errors.length > 0) {
          message += 'Errors:\n';
          results.errors.forEach(error => {
            message += `  ${error.file}: ${error.error}\n`;
          });
        }

        return {
          content: [{
            type: "text",
            text: message.trim()
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
