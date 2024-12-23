import { z } from "zod";
import { Tool, TagOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import { handleFsError } from "../../utils/errors.js";
import {
  validateTag,
  parseNote,
  stringifyNote,
  addTagsToFrontmatter,
  normalizeTag
} from "../../utils/tags.js";
import { createToolResponse, formatTagResult } from "../../utils/responses.js";
import { createSchemaHandler } from "../../utils/schema.js";

// Input validation schema with descriptions
const schema = z.object({
  files: z.array(z.string())
    .min(1, "At least one file must be specified")
    .refine(
      files => files.every(f => f.endsWith('.md')),
      "All files must have .md extension"
    )
    .describe("Array of note filenames to process (must have .md extension)"),
  tags: z.array(z.string())
    .min(1, "At least one tag must be specified")
    .refine(
      tags => tags.every(validateTag),
      "Invalid tag format. Tags must contain only letters, numbers, and forward slashes for hierarchy."
    )
    .describe("Array of tags to add (e.g., 'status/active', 'project/docs')"),
  location: z.enum(['frontmatter', 'content', 'both'])
    .optional()
    .describe("Where to add tags (default: both)"),
  normalize: z.boolean()
    .optional()
    .describe("Whether to normalize tag format (e.g., ProjectActive -> project-active) (default: true)"),
  position: z.enum(['start', 'end'])
    .optional()
    .describe("Where to add inline tags in content (default: end)")
}).strict();

// Create schema handler that provides both Zod validation and JSON Schema
const schemaHandler = createSchemaHandler(schema);

async function addTags(
  vaultPath: string,
  files: string[],
  tags: string[],
  location: 'frontmatter' | 'content' | 'both' = 'both',
  normalize: boolean = true,
  position: 'start' | 'end' = 'end'
): Promise<TagOperationResult> {
  const result: TagOperationResult = {
    success: true,
    message: "Tag addition completed",
    successCount: 0,
    totalCount: files.length,
    failedItems: [],
    details: {}
  };

  for (const filename of files) {
    const fullPath = path.join(vaultPath, filename);
    result.details[filename] = { changes: [] };
    
    try {
      // Validate path is within vault
      validateVaultPath(vaultPath, fullPath);
      
      // Check if file exists
      if (!await fileExists(fullPath)) {
        result.failedItems.push({
          item: filename,
          error: "File not found"
        });
        continue;
      }

      // Read file content
      const content = await safeReadFile(fullPath);
      if (!content) {
        result.failedItems.push({
          item: filename,
          error: "Failed to read file"
        });
        continue;
      }

      // Parse the note
      const parsed = parseNote(content);
      let modified = false;

      // Handle frontmatter tags
      if (location !== 'content') {
        const updatedFrontmatter = addTagsToFrontmatter(
          parsed.frontmatter,
          tags,
          normalize
        );
        
        if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
          parsed.frontmatter = updatedFrontmatter;
          parsed.hasFrontmatter = true;
          modified = true;
          
          // Record changes
          tags.forEach((tag: string) => {
            result.details[filename].changes.push({
              tag: normalize ? normalizeTag(tag) : tag,
              location: 'frontmatter'
            });
          });
        }
      }

      // Handle inline tags
      if (location !== 'frontmatter') {
        const tagString = tags
          .filter(tag => validateTag(tag))
          .map((tag: string) => `#${normalize ? normalizeTag(tag) : tag}`)
          .join(' ');

        if (tagString) {
          if (position === 'start') {
            parsed.content = tagString + '\n\n' + parsed.content.trim();
          } else {
            parsed.content = parsed.content.trim() + '\n\n' + tagString;
          }
          modified = true;
          
          // Record changes
          tags.forEach((tag: string) => {
            result.details[filename].changes.push({
              tag: normalize ? normalizeTag(tag) : tag,
              location: 'content'
            });
          });
        }
      }

      // Save changes if modified
      if (modified) {
        const updatedContent = stringifyNote(parsed);
        await fs.writeFile(fullPath, updatedContent);
        result.successCount++;
      }
    } catch (error) {
      result.failedItems.push({
        item: filename,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Update success status based on results
  result.success = result.failedItems.length === 0;
  result.message = result.success 
    ? `Successfully added tags to ${result.successCount} files`
    : `Completed with ${result.failedItems.length} errors`;

  return result;
}

export function createAddTagsTool(vaultPath: string): Tool {
  return {
    name: "add-tags",
    description: `Add tags to notes in frontmatter and/or content.

Examples:
- Add to both locations: { "files": ["note.md"], "tags": ["status/active"] }
- Add to frontmatter only: { "files": ["note.md"], "tags": ["project/docs"], "location": "frontmatter" }
- Add to start of content: { "files": ["note.md"], "tags": ["type/meeting"], "location": "content", "position": "start" }`,
    inputSchema: schemaHandler,
    handler: async (args) => {
      try {
        const validated = schemaHandler.parse(args);
        const { files, tags, location = 'both', normalize = true, position = 'end' } = validated;
        
        const result = await addTags(vaultPath, files, tags, location, normalize, position);
        
        return createToolResponse(formatTagResult(result));
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
          );
        }
        throw error;
      }
    }
  };
}
