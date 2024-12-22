import { z } from "zod";
import { Tool, FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { ensureDirectory, fileExists } from "../../utils/files.js";
import { createNoteExistsError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createSchemaHandler } from "../../utils/schema.js";

// Input validation schema with descriptions
const schema = z.object({
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'), 
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead. Example: use filename:'note.md', folder:'my/path' instead of filename:'my/path/note.md'")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md'). Will add .md extension if missing"),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("Content of the note in markdown format"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder), 
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root (e.g. 'journal/subfolder'). Use this for the path instead of including it in filename")
}).strict();

// Create schema handler that provides both Zod validation and JSON Schema
const schemaHandler = createSchemaHandler(schema);

async function createNote(
  vaultPath: string,
  filename: string,
  content: string,
  folder?: string
): Promise<FileOperationResult> {
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
    
    return {
      success: true,
      message: "Note created successfully",
      path: notePath,
      operation: 'create'
    };
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
    inputSchema: schemaHandler,
    handler: async (args) => {
      try {
        const validated = schemaHandler.parse(args);
        const { filename, content, folder } = validated;
        const result = await createNote(vaultPath, filename, content, folder);
        
        return createToolResponse(formatFileResult(result));
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
