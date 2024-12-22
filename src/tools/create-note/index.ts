import { z } from "zod";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { ensureDirectory, fileExists } from "../../utils/files.js";
import { createNoteExistsError, handleFsError, handleZodError } from "../../utils/errors.js";

// Improved schema with better validation
export const CreateNoteSchema = z.object({
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead. Example: use filename:'note.md', folder:'my/path' instead of filename:'my/path/note.md'"),
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
  const sanitizedFilename = ensureMarkdownExtension(filename);

  const notePath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  // Validate path is within vault
  validateVaultPath(vaultPath, notePath);

  try {
    // Create directory structure if needed
    const noteDir = path.dirname(notePath);
    await ensureDirectory(noteDir);

    // Check if file exists first
    if (await fileExists(notePath)) {
      throw createNoteExistsError(notePath);
    }

    // File doesn't exist, proceed with creation
    await fs.writeFile(notePath, content, 'utf8');
    return notePath;
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'create note');
  }
}

export function createCreateNoteTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }
  return {
    name: "create-note",
    description: `Create a new note in the vault with markdown content.

Examples:
- Root note: { "filename": "note.md" }
- Subfolder note: { "filename": "note.md", "folder": "journal/2024" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md'). Will add .md extension if missing"
        },
        content: {
          type: "string",
          description: "Content of the note in markdown format"
        },
        folder: {
          type: "string",
          description: "Optional subfolder path relative to vault root (e.g. 'journal/subfolder'). Use this for the path instead of including it in filename"
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
          handleZodError(error);
        }
        throw error;
      }
    }
  };
}
