import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const EditNoteSchema = z.object({
  path: z.string(),
  operation: z.enum(['append', 'prepend', 'replace', 'delete']),
  content: z.string().optional()
});

async function editNote(vaultPath: string, notePath: string, operation: string, content?: string): Promise<void> {
  // Ensure we're only working with the filename
  const filename = path.basename(notePath);
  const fullPath = path.join(vaultPath, filename);

  try {
    if (operation === "delete") {
      await fs.unlink(fullPath);
      return;
    }

    const existingContent = await fs.readFile(fullPath, "utf-8");
    let newContent: string;

    if (operation !== "delete" && !content) {
      throw new McpError(ErrorCode.InvalidParams, `Content is required for ${operation} operation`);
    }

    switch (operation) {
      case "append":
        newContent = `${existingContent}\n${content as string}`;
        break;
      case "prepend":
        newContent = `${content as string}\n${existingContent}`;
        break;
      case "replace":
        newContent = content as string;
        break;
      default:
        throw new McpError(ErrorCode.InvalidParams, `Invalid operation: ${operation}`);
    }

    await fs.writeFile(fullPath, newContent);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new McpError(ErrorCode.InvalidRequest, 
        `Note "${filename}" not found. Please provide only the filename without any path.`);
    }
    throw new McpError(ErrorCode.InternalError, `Failed to ${operation} note: ${error.message}`);
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
      const { path: notePath, operation, content } = EditNoteSchema.parse(args);
      
      // Add validation to ensure only filename is provided
      if (notePath.includes('/') || notePath.includes('\\')) {
        throw new McpError(ErrorCode.InvalidRequest, 
          `Please provide only the filename (e.g., "note.md") rather than a path with directories`);
      }
      
      await editNote(vaultPath, notePath, operation, content);
      return {
        content: [
          {
            type: "text",
            text: `Successfully ${operation}ed note: ${notePath}`
          }
        ]
      };
    }
  };
}
