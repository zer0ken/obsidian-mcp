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
  addTagsToFrontmatter,
  normalizeTag
} from "../../utils/tags.js";

// Schema for tag addition operations
const AddTagsSchema = z.object({
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
    position: z.enum(['start', 'end']).default('end')
  }).default({
    location: 'both',
    normalize: true,
    position: 'end'
  })
});

interface AddTagsReport {
  success: string[];
  errors: { file: string; error: string }[];
  details: {
    [filename: string]: {
      addedTags: {
        tag: string;
        location: 'frontmatter' | 'content';
      }[];
    };
  };
}

async function addTags(
  vaultPath: string,
  params: z.infer<typeof AddTagsSchema>
): Promise<AddTagsReport> {
  const results: AddTagsReport = {
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
        addedTags: []
      };

      // Handle frontmatter tags
      if (params.options.location !== 'content') {
        const updatedFrontmatter = addTagsToFrontmatter(
          parsed.frontmatter,
          params.tags,
          params.options.normalize
        );
        
        if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
          parsed.frontmatter = updatedFrontmatter;
          parsed.hasFrontmatter = true;
          modified = true;
          
          // Record added tags
          params.tags.forEach(tag => {
            results.details[filename].addedTags.push({
              tag: params.options.normalize ? normalizeTag(tag) : tag,
              location: 'frontmatter'
            });
          });
        }
      }

      // Handle inline tags
      if (params.options.location !== 'frontmatter') {
        const tagString = params.tags
          .filter(tag => validateTag(tag))
          .map(tag => `#${params.options.normalize ? normalizeTag(tag) : tag}`)
          .join(' ');

        if (tagString) {
          if (params.options.position === 'start') {
            parsed.content = tagString + '\n\n' + parsed.content.trim();
          } else {
            parsed.content = parsed.content.trim() + '\n\n' + tagString;
          }
          modified = true;
          
          // Record added tags
          params.tags.forEach(tag => {
            results.details[filename].addedTags.push({
              tag: params.options.normalize ? normalizeTag(tag) : tag,
              location: 'content'
            });
          });
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

export function createAddTagsTool(vaultPath: string): Tool {
  return {
    name: "add-tags",
    description: "Add tags to notes in frontmatter and/or content",
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
          description: "Array of tags to add"
        },
        options: {
          type: "object",
          properties: {
            location: {
              type: "string",
              enum: ["frontmatter", "content", "both"],
              description: "Where to add tags"
            },
            normalize: {
              type: "boolean",
              description: "Whether to normalize tag format (e.g., ProjectActive -> project-active)"
            },
            position: {
              type: "string",
              enum: ["start", "end"],
              description: "Where to add inline tags in content"
            }
          }
        }
      },
      required: ["files", "tags"]
    },
    handler: async (args) => {
      try {
        // Parse and validate input
        const params = AddTagsSchema.parse(args);
        
        // Execute tag addition
        const results = await addTags(vaultPath, params);
        
        // Format response message
        let message = '';
        
        // Add success summary
        if (results.success.length > 0) {
          message += `Successfully added tags to: ${results.success.join(', ')}\n\n`;
        }
        
        // Add detailed changes for each file
        for (const [filename, details] of Object.entries(results.details)) {
          if (details.addedTags.length > 0) {
            message += `Changes in ${filename}:\n`;
            const byLocation = details.addedTags.reduce((acc, change) => {
              if (!acc[change.location]) acc[change.location] = new Set();
              acc[change.location].add(change.tag);
              return acc;
            }, {} as Record<string, Set<string>>);
            
            for (const [location, tags] of Object.entries(byLocation)) {
              message += `  ${location}: ${Array.from(tags).join(', ')}\n`;
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
