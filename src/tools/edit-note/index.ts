import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError, handleZodError } from "../../utils/errors.js";

// Improved schema with more precise validation
export const EditNoteSchema = z.object({
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead. Example: use filename:'note.md', folder:'my/path' instead of filename:'my/path/note.md'"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder), 
      "Folder must be a relative path"),
  operation: z.enum(['append', 'prepend', 'replace', 'delete']),
  content: z.string().optional()
    .superRefine((content, ctx) => {
      const operation = (ctx.path[0] as any).operation;
      if (operation === 'delete') {
        if (content !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Content should not be provided for delete operation"
          });
        }
      } else if (!content) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Content is required for non-delete operations"
        });
      }
    })
});

type EditOperation = z.infer<typeof EditNoteSchema>['operation'];

async function editNote(
  vaultPath: string, 
  filename: string,
  operation: EditOperation,
  content?: string,
  folder?: string
): Promise<string> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);
  
  // Validate path is within vault
  validateVaultPath(vaultPath, fullPath);

  try {
    switch (operation) {
      case 'delete': {
        if (!await fileExists(fullPath)) {
          throw createNoteNotFoundError(filename);
        }
        await fs.unlink(fullPath);
        return `Successfully deleted note: ${filename}`;
      }
      
      case 'append':
      case 'prepend':
      case 'replace': {
        // Check if file exists for non-delete operations
        if (!await fileExists(fullPath)) {
          throw createNoteNotFoundError(filename);
        }

        // Read existing content
        const existingContent = await fs.readFile(fullPath, "utf-8");
        
        // Prepare new content based on operation
        let newContent: string;
        if (operation === 'append') {
          newContent = existingContent.trim() + (existingContent.trim() ? '\n\n' : '') + content;
        } else if (operation === 'prepend') {
          newContent = content + (existingContent.trim() ? '\n\n' : '') + existingContent.trim();
        } else {
          // replace
          newContent = content as string;
        }

        // Write the new content
        await fs.writeFile(fullPath, newContent);
        return `Successfully ${operation}ed note: ${filename}`;
      }
      
      default: {
        const _exhaustiveCheck: never = operation;
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid operation: ${operation}`
        );
      }
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, `${operation} note`);
  }
}

export function createEditNoteTool(vaultPath: string): Tool {
  return {
    name: "edit-note",
    description: `Edit an existing note in the vault.

Examples:
- Root note: { "filename": "note.md", "operation": "append", "content": "new content" }
- Subfolder note: { "filename": "note.md", "folder": "journal/2024", "operation": "append", "content": "new content" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string", 
          description: "Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md'). Will add .md extension if missing"
        },
        folder: {
          type: "string",
          description: "Optional subfolder path relative to vault root (e.g. 'journal/subfolder'). Use this for the path instead of including it in filename"
        },
        operation: {
          type: "string",
          enum: ["append", "prepend", "replace", "delete"],
          description: "Type of edit operation"
        },
        content: {
          type: "string",
          description: "New content (not needed for delete)"
        }
      },
      required: ["filename", "operation"]
    },
    handler: async (args) => {
      try {
        // Parse and validate input
        const { filename, folder, operation, content } = EditNoteSchema.parse(args);
        
        // Execute the edit operation
        const resultMessage = await editNote(vaultPath, filename, operation, content, folder);
        
        // Return a more informative response
        return {
          content: [
            {
              type: "text",
              text: resultMessage
            }
          ]
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
