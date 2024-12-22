import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError, handleZodError } from "../../utils/errors.js";

// Improved schema with more precise validation
export const EditNoteSchema = z.object({
  path: z.string()
    .min(1, "Filename cannot be empty")
    .refine(
      name => !name.includes('/') && !name.includes('\\'),
      "Please provide only the filename without any path separators"
    )
    .refine(
      name => name.endsWith('.md'),
      "Note must have .md extension"
    ),
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
  content?: string
): Promise<string> {
  const fullPath = path.join(vaultPath, filename);
  
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
    description: "Edit an existing note (use only filename, not full path)",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Name of the note file (e.g., 'note.md'), not full path"
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
      required: ["path", "operation"]
    },
    handler: async (args) => {
      try {
        // Parse and validate input
        const { path: notePath, operation, content } = EditNoteSchema.parse(args);
        
        // Execute the edit operation
        const resultMessage = await editNote(vaultPath, notePath, operation, content);
        
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
