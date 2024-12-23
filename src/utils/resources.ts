import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { parseNote, extractTags } from "./tags.js";
import { getAllMarkdownFiles, safeReadFile } from "./files.js";
import { normalizePath, safeJoinPath } from "./path.js";

export interface NoteMetadata {
  title: string;
  path: string;
  tags: string[];
  frontmatter: Record<string, any>;
  links: string[];
  lastModified: Date;
  created?: Date;
}

export interface NoteResource {
  uri: string;
  name: string;
  mimeType: string;
  metadata?: NoteMetadata;
}

export interface NoteResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Extracts links from note content
 */
function extractLinks(content: string): string[] {
  const links = new Set<string>();
  
  // Match both wikilinks [[Note]] and markdown links [Note](Note.md)
  const WIKILINK_PATTERN = /\[\[([^\]]+?)(\|[^\]]+)?\]\]/g;
  const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
  
  // Extract wikilinks
  let match;
  while ((match = WIKILINK_PATTERN.exec(content)) !== null) {
    links.add(match[1].split('|')[0].trim());
  }
  
  // Extract markdown links
  while ((match = MARKDOWN_LINK_PATTERN.exec(content)) !== null) {
    const linkPath = match[2];
    const noteName = path.basename(linkPath, '.md');
    links.add(noteName);
  }
  
  return Array.from(links);
}

/**
 * Gets metadata for a note
 */
export async function getNoteMetadata(notePath: string): Promise<NoteMetadata> {
  const content = await safeReadFile(notePath);
  if (!content) {
    throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${notePath}`);
  }

  const stats = await fs.stat(notePath);
  const parsed = parseNote(content);
  const links = extractLinks(content);
  const inlineTags = extractTags(parsed.content);
  const frontmatterTags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
  
  // Combine and deduplicate tags
  const allTags = [...new Set([...inlineTags, ...frontmatterTags])];

  return {
    title: path.basename(notePath, '.md'),
    path: notePath,
    tags: allTags,
    frontmatter: parsed.frontmatter,
    links,
    lastModified: stats.mtime,
    created: stats.birthtime
  };
}

/**
 * Lists all notes in the vault with their metadata
 */
export async function listNoteResources(vaultPath: string): Promise<NoteResource[]> {
  const files = await getAllMarkdownFiles(vaultPath);
  const resources: NoteResource[] = [];

  for (const file of files) {
    try {
      const metadata = await getNoteMetadata(file);
      resources.push({
        uri: `obsidian://${file}`,
        name: metadata.title,
        mimeType: "text/markdown",
        metadata
      });
    } catch (error) {
      // Log error but continue processing other files
      console.error(`Error processing ${file}:`, error);
    }
  }

  return resources;
}

/**
 * Gets available resource templates
 */
export function getNoteResourceTemplates(): NoteResourceTemplate[] {
  return [
    {
      uriTemplate: "obsidian://{path}",
      name: "Note by path",
      description: "Access a note by its path within the vault",
      mimeType: "text/markdown"
    },
    {
      uriTemplate: "obsidian://tag/{tag}",
      name: "Notes by tag",
      description: "Access all notes with a specific tag",
      mimeType: "application/json"
    },
    {
      uriTemplate: "obsidian://search/{query}",
      name: "Search notes",
      description: "Search notes by content",
      mimeType: "application/json"
    }
  ];
}

/**
 * Reads a note resource by URI
 */
export async function readNoteResource(
  vaultPath: string,
  uri: string
): Promise<{ uri: string; mimeType: string; text: string }> {
  // Handle different URI patterns
  if (uri.startsWith("obsidian://tag/")) {
    const tag = decodeURIComponent(uri.replace("obsidian://tag/", ""));
    const files = await getAllMarkdownFiles(vaultPath);
    const matchingNotes: NoteMetadata[] = [];

    for (const file of files) {
      try {
        const metadata = await getNoteMetadata(file);
        if (metadata.tags.includes(tag)) {
          matchingNotes.push(metadata);
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(matchingNotes, null, 2)
    };
  }

  if (uri.startsWith("obsidian://search/")) {
    const query = decodeURIComponent(uri.replace("obsidian://search/", ""));
    const files = await getAllMarkdownFiles(vaultPath);
    const results = [];

    for (const file of files) {
      try {
        const content = await safeReadFile(file);
        if (content && content.toLowerCase().includes(query.toLowerCase())) {
          const metadata = await getNoteMetadata(file);
          results.push(metadata);
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(results, null, 2)
    };
  }

  // Default case: direct note access
  const notePath = uri.replace("obsidian://", "");
  const normalizedPath = normalizePath(notePath);
  
  // Verify path is within vault
  if (!normalizedPath.startsWith(normalizePath(vaultPath))) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Note path must be within vault: ${notePath}`
    );
  }

  const content = await safeReadFile(normalizedPath);
  if (!content) {
    throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${notePath}`);
  }

  return {
    uri,
    mimeType: "text/markdown",
    text: content
  };
}
