import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Improved schema with better validation
export const CreateNoteSchema = z.object({
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators"),
  content: z.string()
    .min(1, "Content cannot be empty"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder), 
      "Folder must be a relative path")
});

async function createNote(
  vaultPath: string, 
  filename: string, 
  content: string, 
  folder?: string
): Promise<string> {
  const sanitizedFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
  
  const notePath = folder 
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  // Validate path is within vault
  const normalizedNotePath = path.normalize(notePath);
  if (!normalizedNotePath.startsWith(path.normalize(vaultPath))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Note path must be within the vault directory"
    );
  }

  try {
    // Create directory structure if needed
    const noteDir = path.dirname(normalizedNotePath);
    await fs.mkdir(noteDir, { recursive: true });

    // Check if file exists first
    try {
      await fs.access(normalizedNotePath);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `A note already exists at: ${normalizedNotePath}\n\n` +
        'To prevent accidental modifications, this operation has been cancelled.\n' +
        'If you want to modify an existing note, please explicitly request to edit or replace it.'
      );
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist, proceed with creation
      await fs.writeFile(normalizedNotePath, content, 'utf8');
      return normalizedNotePath;
    }
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to create note: ${error.message}`
    );
  }
}

export function createCreateNoteTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "create-note",
    description: "Create a new note in the vault with markdown content",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Name of the note (will add .md extension if missing)"
        },
        content: {
          type: "string",
          description: "Content of the note in markdown format"
        },
        folder: {
          type: "string",
          description: "Optional subfolder path (relative to vault root)"
        }
      },
      required: ["filename", "content"]
    },
    handler: async (args) => {
      try {
        const { filename, content, folder } = CreateNoteSchema.parse(args);
        const notePath = await createNote(vaultPath, filename, content, folder);
        
        return {
          content: [
            {
              type: "text",
              text: `Successfully created note at: ${notePath}`
            }
          ]
        };
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