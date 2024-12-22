import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Tool } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import {
  validateTag,
  normalizeTag,
  parseNote,
  stringifyNote,
  getRelatedTags,
  extractTags
} from "../../utils/tags.js";
import {
  getAllMarkdownFiles,
  safeReadFile,
  fileExists
} from "../../utils/files.js";

interface RenameTagOptions {
  createBackup?: boolean;
  normalize?: boolean;
  batchSize?: number;
}

interface TagReplacement {
  oldTag: string;
  newTag: string;
}

interface TagChangeReport {
  filePath: string;
  oldTags: string[];
  newTags: string[];
  location: 'frontmatter' | 'content';
  line?: number;
}

interface RenameTagReport {
  successful: TagChangeReport[];
  failed: {
    filePath: string;
    error: string;
  }[];
  timestamp: string;
  backupCreated?: string;
}

/**
 * Creates a backup of the vault
 */
async function createVaultBackup(vaultPath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(vaultPath, '.backup');
  const backupPath = path.join(backupDir, `vault-backup-${timestamp}`);

  await fs.mkdir(backupDir, { recursive: true });
  
  // Copy all markdown files to backup
  const files = await getAllMarkdownFiles(vaultPath);
  for (const file of files) {
    const relativePath = path.relative(vaultPath, file);
    const backupFile = path.join(backupPath, relativePath);
    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.copyFile(file, backupFile);
  }

  return backupPath;
}

/**
 * Updates tags in frontmatter
 */
function updateFrontmatterTags(
  frontmatter: Record<string, any>,
  replacements: TagReplacement[],
  normalize: boolean
): {
  frontmatter: Record<string, any>;
  changes: { oldTag: string; newTag: string }[];
} {
  const changes: { oldTag: string; newTag: string }[] = [];
  const updatedFrontmatter = { ...frontmatter };
  
  if (!Array.isArray(frontmatter.tags)) {
    return { frontmatter: updatedFrontmatter, changes };
  }

  const updatedTags = frontmatter.tags.map(tag => {
    const normalizedTag = normalizeTag(tag, normalize);
    
    for (const { oldTag, newTag } of replacements) {
      const normalizedOldTag = normalizeTag(oldTag, normalize);
      
      if (normalizedTag === normalizedOldTag || 
          normalizedTag.startsWith(normalizedOldTag + '/')) {
        const updatedTag = normalizedTag.replace(
          new RegExp(`^${normalizedOldTag}`),
          normalizeTag(newTag, normalize)
        );
        changes.push({ oldTag: normalizedTag, newTag: updatedTag });
        return updatedTag;
      }
    }
    
    return normalizedTag;
  });

  updatedFrontmatter.tags = Array.from(new Set(updatedTags)).sort();
  return { frontmatter: updatedFrontmatter, changes };
}

/**
 * Updates inline tags in content
 */
function updateInlineTags(
  content: string,
  replacements: TagReplacement[],
  normalize: boolean
): {
  content: string;
  changes: { oldTag: string; newTag: string; line: number }[];
} {
  const changes: { oldTag: string; newTag: string; line: number }[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;
  let inHtmlComment = false;

  const updatedLines = lines.map((line, lineNum) => {
    // Handle code blocks and comments
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (line.includes('<!--')) inHtmlComment = true;
    if (line.includes('-->')) inHtmlComment = false;
    if (inCodeBlock || inHtmlComment) return line;

    // Update tags in regular content
    return line.replace(
      /(?<!`)#[a-zA-Z0-9][a-zA-Z0-9/]*(?!`)/g,
      (match) => {
        const tag = match.slice(1);
        const normalizedTag = normalizeTag(tag, normalize);

        for (const { oldTag, newTag } of replacements) {
          const normalizedOldTag = normalizeTag(oldTag, normalize);
          
          if (normalizedTag === normalizedOldTag ||
              normalizedTag.startsWith(normalizedOldTag + '/')) {
            const updatedTag = normalizedTag.replace(
              new RegExp(`^${normalizedOldTag}`),
              normalizeTag(newTag, normalize)
            );
            changes.push({
              oldTag: normalizedTag,
              newTag: updatedTag,
              line: lineNum + 1
            });
            return `#${updatedTag}`;
          }
        }

        return match;
      }
    );
  });

  return {
    content: updatedLines.join('\n'),
    changes
  };
}

/**
 * Updates saved searches and filters
 */
async function updateSavedSearches(
  vaultPath: string,
  replacements: TagReplacement[],
  normalize: boolean
): Promise<void> {
  const searchConfigPath = path.join(vaultPath, '.obsidian', 'search.json');
  
  if (!await fileExists(searchConfigPath)) return;

  try {
    const searchConfig = JSON.parse(
      await fs.readFile(searchConfigPath, 'utf-8')
    );

    let modified = false;
    
    // Update saved searches
    if (Array.isArray(searchConfig.savedSearches)) {
      searchConfig.savedSearches = searchConfig.savedSearches.map(
        (search: any) => {
          if (typeof search.query !== 'string') return search;

          let updatedQuery = search.query;
          for (const { oldTag, newTag } of replacements) {
            const normalizedOldTag = normalizeTag(oldTag, normalize);
            const normalizedNewTag = normalizeTag(newTag, normalize);
            
            // Update tag queries
            updatedQuery = updatedQuery.replace(
              new RegExp(`tag:${normalizedOldTag}(/\\S*)?`, 'g'),
              `tag:${normalizedNewTag}$1`
            );
            
            // Update raw tag references
            updatedQuery = updatedQuery.replace(
              new RegExp(`#${normalizedOldTag}(/\\S*)?`, 'g'),
              `#${normalizedNewTag}$1`
            );
          }

          if (updatedQuery !== search.query) {
            modified = true;
            return { ...search, query: updatedQuery };
          }
          return search;
        }
      );
    }

    if (modified) {
      await fs.writeFile(
        searchConfigPath,
        JSON.stringify(searchConfig, null, 2)
      );
    }
  } catch (error) {
    console.error('Error updating saved searches:', error);
    // Continue with other operations
  }
}

/**
 * Processes files in batches to handle large vaults
 */
async function processBatch(
  files: string[],
  start: number,
  batchSize: number,
  replacements: TagReplacement[],
  normalize: boolean
): Promise<{
  successful: TagChangeReport[];
  failed: { filePath: string; error: string }[];
}> {
  const batch = files.slice(start, start + batchSize);
  const successful: TagChangeReport[] = [];
  const failed: { filePath: string; error: string }[] = [];

  await Promise.all(
    batch.map(async (filePath) => {
      try {
        const content = await safeReadFile(filePath);
        if (!content) {
          failed.push({
            filePath,
            error: 'File not found or cannot be read'
          });
          return;
        }

        const parsed = parseNote(content);
        
        // Update frontmatter tags
        const { frontmatter: updatedFrontmatter, changes: frontmatterChanges } =
          updateFrontmatterTags(parsed.frontmatter, replacements, normalize);
        
        // Update inline tags
        const { content: updatedContent, changes: contentChanges } =
          updateInlineTags(parsed.content, replacements, normalize);

        // Only write file if changes were made
        if (frontmatterChanges.length > 0 || contentChanges.length > 0) {
          const updatedNote = stringifyNote({
            ...parsed,
            frontmatter: updatedFrontmatter,
            content: updatedContent
          });
          
          await fs.writeFile(filePath, updatedNote, 'utf-8');

          // Record changes
          if (frontmatterChanges.length > 0) {
            successful.push({
              filePath,
              oldTags: frontmatterChanges.map(c => c.oldTag),
              newTags: frontmatterChanges.map(c => c.newTag),
              location: 'frontmatter'
            });
          }

          if (contentChanges.length > 0) {
            successful.push({
              filePath,
              oldTags: contentChanges.map(c => c.oldTag),
              newTags: contentChanges.map(c => c.newTag),
              location: 'content',
              line: contentChanges[0].line
            });
          }
        }
      } catch (error) {
        failed.push({
          filePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })
  );

  return { successful, failed };
}

/**
 * Renames tags throughout the vault while preserving hierarchies
 */
/**
 * Creates the rename-tag tool
 */
export function createRenameTagTool(vaultPath: string): Tool {
  return {
    name: 'rename-tag',
    description: 'Safely renames tags throughout the vault while preserving hierarchies',
    inputSchema: {
      type: 'object',
      properties: {
        oldTag: {
          type: 'string',
          description: 'The tag to rename (without #)',
        },
        newTag: {
          type: 'string',
          description: 'The new tag name (without #)',
        },
        createBackup: {
          type: 'boolean',
          description: 'Whether to create a backup before making changes',
          default: true,
        },
        normalize: {
          type: 'boolean',
          description: 'Whether to normalize tag names',
          default: true,
        },
        batchSize: {
          type: 'number',
          description: 'Number of files to process in each batch',
          default: 50,
        },
      },
      required: ['oldTag', 'newTag'],
    },
    handler: async (args: {
      oldTag: string;
      newTag: string;
      createBackup?: boolean;
      normalize?: boolean;
      batchSize?: number;
    }) => {
      const report = await renameTag(
        vaultPath,
        args.oldTag,
        args.newTag,
        {
          createBackup: args.createBackup,
          normalize: args.normalize,
          batchSize: args.batchSize,
        }
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(report, null, 2),
        }],
      };
    },
  };
}

async function renameTag(
  vaultPath: string,
  oldTag: string,
  newTag: string,
  options: RenameTagOptions = {}
): Promise<RenameTagReport> {
  const {
    createBackup = true,
    normalize = true,
    batchSize = 50
  } = options;

  // Validate tags
  if (!validateTag(oldTag) || !validateTag(newTag)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid tag format'
    );
  }

  // Create backup if requested
  let backupPath: string | undefined;
  if (createBackup) {
    backupPath = await createVaultBackup(vaultPath);
  }

  // Get all markdown files
  const files = await getAllMarkdownFiles(vaultPath);
  
  // Process files in batches
  const successful: TagChangeReport[] = [];
  const failed: { filePath: string; error: string }[] = [];
  
  for (let i = 0; i < files.length; i += batchSize) {
    const { successful: batchSuccessful, failed: batchFailed } =
      await processBatch(
        files,
        i,
        batchSize,
        [{ oldTag, newTag }],
        normalize
      );
    
    successful.push(...batchSuccessful);
    failed.push(...batchFailed);
  }

  // Update saved searches
  await updateSavedSearches(
    vaultPath,
    [{ oldTag, newTag }],
    normalize
  );

  return {
    successful,
    failed,
    timestamp: new Date().toISOString(),
    backupCreated: backupPath
  };
}
