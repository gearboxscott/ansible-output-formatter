import * as vscode from 'vscode';

/**
 * Normalize newlines in Ansible output text.
 * Handles various escape sequences that appear in Ansible/Python output:
 * - Backslash-continuation (\ at end of line)
 * - Literal \n sequences
 * - Double-escaped sequences
 */
function normalizeNewlines(text: string): string {
    let result = text;

    // Handle backslash-continuation: \ followed by actual newline
    // This appears in Ansible output as: "some text\
    //      - item1\
    //      - item2"
    result = result.replace(/\\\n\s*/g, '\n');

    // Handle literal \n sequences (Python string escapes that weren't interpreted)
    result = result.replace(/\\n/g, '\n');

    // Handle double-escaped newlines (\\n -> \n in the output)
    result = result.replace(/\\\\\n/g, '\n');

    return result;
}

function convertPythonToJSON(text: string): string {
    let result = text;

    // Replace Python boolean/null literals (only when not inside quotes)
    // We need to be careful to only replace these when they're actual keywords
    result = result.replace(/\bTrue\b/g, 'true');
    result = result.replace(/\bFalse\b/g, 'false');
    result = result.replace(/\bNone\b/g, 'null');

    // Convert single quotes to double quotes, handling nested quotes carefully
    // Also handle backslash-continuations and convert them to \n in strings
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let converted = '';
    let i = 0;

    while (i < result.length) {
        const char = result[i];

        // Check for backslash
        if (char === '\\') {
            // Look at what follows
            if (i + 1 < result.length) {
                const nextChar = result[i + 1];

                if (nextChar === '\n') {
                    // Backslash-continuation: \ followed by newline
                    // In a string context, convert to \n escape sequence
                    if (inSingleQuote || inDoubleQuote) {
                        converted += '\\n';
                        // Skip the backslash and newline
                        i += 2;
                        // Also skip any leading whitespace on the next line
                        while (i < result.length && (result[i] === ' ' || result[i] === '\t')) {
                            i++;
                        }
                        continue;
                    } else {
                        // Outside string, just skip the continuation
                        i += 2;
                        while (i < result.length && (result[i] === ' ' || result[i] === '\t')) {
                            i++;
                        }
                        continue;
                    }
                } else if (nextChar === "'") {
                    // Escaped single quote
                    if (inSingleQuote) {
                        // In a single-quoted string, \' becomes just '
                        converted += "'";
                        i += 2;
                        continue;
                    } else {
                        // Outside single quote, keep as-is
                        converted += "\\'";
                        i += 2;
                        continue;
                    }
                } else if (nextChar === '"') {
                    // Escaped double quote - keep it escaped
                    converted += '\\"';
                    i += 2;
                    continue;
                } else if (nextChar === '\\') {
                    // Double backslash
                    converted += '\\\\';
                    i += 2;
                    continue;
                } else if (nextChar === 'n') {
                    // Literal \n sequence - keep as JSON escape
                    converted += '\\n';
                    i += 2;
                    continue;
                } else if (nextChar === 't') {
                    // Literal \t sequence
                    converted += '\\t';
                    i += 2;
                    continue;
                } else if (nextChar === 'r') {
                    // Literal \r sequence
                    converted += '\\r';
                    i += 2;
                    continue;
                } else {
                    // Other escape sequence - keep the backslash and the next char
                    converted += '\\' + nextChar;
                    i += 2;
                    continue;
                }
            } else {
                // Trailing backslash
                converted += '\\';
                i++;
                continue;
            }
        }

        if (char === '"') {
            if (inSingleQuote) {
                // Unescaped double quote inside single-quoted string - needs escaping in JSON
                converted += '\\"';
            } else {
                inDoubleQuote = !inDoubleQuote;
                converted += char;
            }
        } else if (char === "'") {
            if (inDoubleQuote) {
                // Single quote inside double-quoted string - just add it
                converted += char;
            } else {
                inSingleQuote = !inSingleQuote;
                converted += '"'; // Convert to double quote
            }
        } else if (char === '\n') {
            // Actual newline in the source - if inside a string, escape it
            if (inSingleQuote || inDoubleQuote) {
                converted += '\\n';
            } else {
                converted += char;
            }
        } else {
            converted += char;
        }
        i++;
    }

    return converted;
}

/**
 * Find matching brace for JSON content (handles both inline and pre-formatted JSON)
 * This version tracks both single and double quotes and handles newlines in strings
 */
function findMatchingBrace(text: string, startIdx: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escapeNext = false;

    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        // Handle string boundaries (both single and double quotes for mixed content)
        if ((char === '"' || char === "'") && !inString) {
            inString = true;
            stringChar = char;
            continue;
        }

        if (inString && char === stringChar) {
            inString = false;
            stringChar = '';
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                depth++;
            } else if (char === closeChar) {
                depth--;
                if (depth === 0) {
                    return i;
                }
            }
        }
    }

    return -1;
}

/**
 * Find matching brace for Python dict content (handles both single and double quotes)
 */
function findMatchingBracePython(text: string, startIdx: number, openChar: string, closeChar: string): number {
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escapeNext = false;

    for (let i = startIdx; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        // Handle string delimiters
        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }

        if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }

        // Only count braces when not inside a string
        if (!inSingleQuote && !inDoubleQuote) {
            if (char === openChar) {
                depth++;
            } else if (char === closeChar) {
                depth--;
                if (depth === 0) {
                    return i;
                }
            }
        }
    }

    return -1;
}

/**
 * Clean up JSON that contains backslash-continuation sequences and
 * double-escaped quotes (\\") that appear in Ansible output.
 * Converts backslash-newline to \n escape and fixes \\" to \"
 */
function cleanupJSONBackslashContinuations(text: string): string {
    let result = '';
    let inString = false;
    let i = 0;

    while (i < text.length) {
        const char = text[i];

        if (char === '\\' && i + 1 < text.length) {
            const nextChar = text[i + 1];

            if (nextChar === '\n') {
                // Backslash-continuation
                if (inString) {
                    // Inside a string, convert to \n escape
                    result += '\\n';
                }
                // Skip the \ and newline
                i += 2;
                // Skip any leading whitespace on the continuation line
                while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
                    i++;
                }
                continue;
            } else if (nextChar === '\\' && i + 2 < text.length && text[i + 2] === '"') {
                // Double-escaped quote: \\" -> \"
                // This is Ansible's way of representing quotes in JSON strings
                result += '\\"';
                i += 3;  // Skip all three characters: \ \ "
                continue;
            } else if (nextChar === '\\') {
                // Escaped backslash (not followed by quote)
                result += '\\\\';
                i += 2;
                continue;
            } else if (nextChar === '"') {
                // Escaped quote
                result += '\\"';
                i += 2;
                continue;
            } else {
                // Other escape sequence - keep as is
                result += char;
                i++;
                continue;
            }
        }

        if (char === '"') {
            // Toggle string state (only unescaped quotes reach here)
            inString = !inString;
        }

        result += char;
        i++;
    }

    return result;
}

export function activate(context: vscode.ExtensionContext) {
    // Command to format output
    let formatDisposable = vscode.commands.registerCommand('ansibleFormatter.formatOutput', () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const document = editor.document;
        let text = document.getText();

        try {
            // First, normalize all escaped newline sequences
            text = normalizeNewlines(text);

            let result = '';
            let i = 0;

            while (i < text.length) {
                const char = text[i];

                // Check for Python dict pattern: (item={...}) or (item=\n{...})
                if (char === '(' && text.substring(i, i + 6) === '(item=') {
                    let itemStart = i + 6;

                    // Skip any whitespace/newlines after 'item='
                    while (itemStart < text.length && (text[itemStart] === ' ' || text[itemStart] === '\t' || text[itemStart] === '\n' || text[itemStart] === '\r')) {
                        itemStart++;
                    }

                    if (text[itemStart] === '{') {
                        // Use Python-aware brace matching for Python dicts
                        const endBrace = findMatchingBracePython(text, itemStart, '{', '}');

                        if (endBrace !== -1) {
                            let closeParenIdx = endBrace + 1;
                            // Skip whitespace after closing brace
                            while (closeParenIdx < text.length && (text[closeParenIdx] === ' ' || text[closeParenIdx] === '\t' || text[closeParenIdx] === '\n' || text[closeParenIdx] === '\r')) {
                                closeParenIdx++;
                            }
                            // Find the closing paren
                            while (closeParenIdx < text.length && text[closeParenIdx] !== ')') {
                                closeParenIdx++;
                            }

                            if (closeParenIdx < text.length) {
                                const pythonDict = text.substring(itemStart, endBrace + 1);

                                try {
                                    const jsonStr = convertPythonToJSON(pythonDict);
                                    const parsed = JSON.parse(jsonStr);
                                    const formatted = JSON.stringify(parsed, null, 2);

                                    result += '(item=\n' + formatted + '\n)';
                                    i = closeParenIdx + 1;
                                    continue;
                                } catch (e) {
                                    // If Python conversion fails, try parsing as JSON directly
                                    try {
                                        const parsed = JSON.parse(pythonDict);
                                        const formatted = JSON.stringify(parsed, null, 2);
                                        result += '(item=\n' + formatted + '\n)';
                                        i = closeParenIdx + 1;
                                        continue;
                                    } catch (e2) {
                                        result += char;
                                        i++;
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                }

                // Check for => followed by JSON (common pattern in Ansible output)
                if (char === '=' && i + 1 < text.length && text[i + 1] === '>') {
                    result += '=>';
                    i += 2;

                    // Skip whitespace and newlines after =>
                    const startAfterArrow = i;
                    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
                        i++;
                    }

                    // Check if next char is { or [ (JSON start)
                    if (i < text.length && (text[i] === '{' || text[i] === '[')) {
                        const closeChar = text[i] === '{' ? '}' : ']';
                        const endIdx = findMatchingBrace(text, i, text[i], closeChar);

                        if (endIdx !== -1) {
                            const potentialJSON = text.substring(i, endIdx + 1);

                            // Try to parse and format the JSON
                            try {
                                const parsed = JSON.parse(potentialJSON);
                                const formatted = JSON.stringify(parsed, null, 2);
                                result += '\n' + formatted;
                                i = endIdx + 1;
                                continue;
                            } catch (e) {
                                // If direct parse fails, try cleaning up backslash-newlines
                                try {
                                    const cleaned = cleanupJSONBackslashContinuations(potentialJSON);
                                    const parsed = JSON.parse(cleaned);
                                    const formatted = JSON.stringify(parsed, null, 2);
                                    result += '\n' + formatted;
                                    i = endIdx + 1;
                                    continue;
                                } catch (e2) {
                                    // Still failed - restore position to after => and let normal processing continue
                                    // Add back any whitespace we skipped
                                    result += text.substring(startAfterArrow, i);
                                    // Don't increment i - the main loop will process from current position (the {)
                                    continue;
                                }
                            }
                        }
                    }

                    // No JSON found after =>, restore skipped whitespace
                    result += text.substring(startAfterArrow, i);
                    continue;
                }

                // Check for JSON objects/arrays that start with { or [
                if (char === '{' || char === '[') {
                    const closeChar = char === '{' ? '}' : ']';
                    const endIdx = findMatchingBrace(text, i, char, closeChar);

                    if (endIdx !== -1) {
                        const potentialJSON = text.substring(i, endIdx + 1);

                        try {
                            const parsed = JSON.parse(potentialJSON);

                            // Check if there's content before this JSON on the same line
                            let lineStart = i;
                            while (lineStart > 0 && text[lineStart - 1] !== '\n') {
                                lineStart--;
                            }

                            const beforeJSON = text.substring(lineStart, i).trim();

                            // Only format standalone JSON or JSON that follows specific patterns
                            // Avoid reformatting JSON that's already part of a formatted structure
                            if (beforeJSON.length === 0 || beforeJSON.endsWith('=>') || beforeJSON.endsWith(':')) {
                                const formatted = JSON.stringify(parsed, null, 2);

                                // If there's content before, add newline
                                if (beforeJSON.length > 0 && !beforeJSON.endsWith('\n')) {
                                    result += '\n';
                                }

                                result += formatted;
                                i = endIdx + 1;
                                continue;
                            }
                        } catch (e) {
                            // Not valid JSON, just add the character
                        }
                    }
                }

                result += char;
                i++;
            }

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(text.length)
            );

            editor.edit(editBuilder => {
                editBuilder.replace(fullRange, result);
            }).then(success => {
                if (success) {
                    // Set the language to ansible-output for syntax highlighting
                    vscode.languages.setTextDocumentLanguage(document, 'ansible-output').then(() => {
                        vscode.window.showInformationMessage('Ansible output formatted successfully!');

                        // Try to fold all JSON structures
                        setTimeout(() => {
                            vscode.commands.executeCommand('editor.foldAll');
                        }, 200);
                    });
                } else {
                    vscode.window.showErrorMessage('Failed to format output');
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Error formatting: ${error}`);
        }
    });

    context.subscriptions.push(formatDisposable);

    // Command to manually set language
    let setLanguageDisposable = vscode.commands.registerCommand('ansibleFormatter.setLanguage', () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        vscode.languages.setTextDocumentLanguage(editor.document, 'ansible-output').then(() => {
            vscode.window.showInformationMessage('Language set to Ansible Output - syntax highlighting applied');
        });
    });

    context.subscriptions.push(setLanguageDisposable);

    // Combined command - format AND set language (this is the main one to use)
    let formatAndHighlightDisposable = vscode.commands.registerCommand('ansibleFormatter.formatAndHighlight', async () => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const document = editor.document;
        let text = document.getText();

        try {
            // First, normalize all escaped newline sequences
            text = normalizeNewlines(text);

            let result = '';
            let i = 0;

            while (i < text.length) {
                const char = text[i];

                // Check for Python dict pattern: (item={...}) or (item=\n{...})
                if (char === '(' && text.substring(i, i + 6) === '(item=') {
                    let itemStart = i + 6;

                    // Skip any whitespace/newlines after 'item='
                    while (itemStart < text.length && (text[itemStart] === ' ' || text[itemStart] === '\t' || text[itemStart] === '\n' || text[itemStart] === '\r')) {
                        itemStart++;
                    }

                    if (text[itemStart] === '{') {
                        // Use Python-aware brace matching for Python dicts
                        const endBrace = findMatchingBracePython(text, itemStart, '{', '}');

                        if (endBrace !== -1) {
                            let closeParenIdx = endBrace + 1;
                            // Skip whitespace after closing brace
                            while (closeParenIdx < text.length && (text[closeParenIdx] === ' ' || text[closeParenIdx] === '\t' || text[closeParenIdx] === '\n' || text[closeParenIdx] === '\r')) {
                                closeParenIdx++;
                            }
                            // Find the closing paren
                            while (closeParenIdx < text.length && text[closeParenIdx] !== ')') {
                                closeParenIdx++;
                            }

                            if (closeParenIdx < text.length) {
                                const pythonDict = text.substring(itemStart, endBrace + 1);

                                try {
                                    const jsonStr = convertPythonToJSON(pythonDict);
                                    const parsed = JSON.parse(jsonStr);
                                    const formatted = JSON.stringify(parsed, null, 2);

                                    result += '(item=\n' + formatted + '\n)';
                                    i = closeParenIdx + 1;
                                    continue;
                                } catch (e) {
                                    // If Python conversion fails, try parsing as JSON directly
                                    try {
                                        const parsed = JSON.parse(pythonDict);
                                        const formatted = JSON.stringify(parsed, null, 2);
                                        result += '(item=\n' + formatted + '\n)';
                                        i = closeParenIdx + 1;
                                        continue;
                                    } catch (e2) {
                                        result += char;
                                        i++;
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                }

                if (char === '=' && i + 1 < text.length && text[i + 1] === '>') {
                    result += '=>';
                    i += 2;

                    // Skip whitespace and newlines after =>
                    const startAfterArrow = i;
                    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
                        i++;
                    }

                    if (i < text.length && (text[i] === '{' || text[i] === '[')) {
                        const closeChar = text[i] === '{' ? '}' : ']';
                        const endIdx = findMatchingBrace(text, i, text[i], closeChar);

                        if (endIdx !== -1) {
                            const potentialJSON = text.substring(i, endIdx + 1);

                            // Try to parse and format the JSON
                            try {
                                const parsed = JSON.parse(potentialJSON);
                                const formatted = JSON.stringify(parsed, null, 2);
                                result += '\n' + formatted;
                                i = endIdx + 1;
                                continue;
                            } catch (e) {
                                // If direct parse fails, try cleaning up backslash-newlines
                                try {
                                    const cleaned = cleanupJSONBackslashContinuations(potentialJSON);
                                    const parsed = JSON.parse(cleaned);
                                    const formatted = JSON.stringify(parsed, null, 2);
                                    result += '\n' + formatted;
                                    i = endIdx + 1;
                                    continue;
                                } catch (e2) {
                                    // Still failed - restore position to after => and let normal processing continue
                                    result += text.substring(startAfterArrow, i);
                                    continue;
                                }
                            }
                        }
                    }

                    // No JSON found after =>, restore skipped whitespace
                    result += text.substring(startAfterArrow, i);
                    continue;
                }

                if (char === '{' || char === '[') {
                    const closeChar = char === '{' ? '}' : ']';
                    const endIdx = findMatchingBrace(text, i, char, closeChar);

                    if (endIdx !== -1) {
                        const potentialJSON = text.substring(i, endIdx + 1);

                        try {
                            const parsed = JSON.parse(potentialJSON);

                            let lineStart = i;
                            while (lineStart > 0 && text[lineStart - 1] !== '\n') {
                                lineStart--;
                            }

                            const beforeJSON = text.substring(lineStart, i).trim();

                            if (beforeJSON.length === 0 || beforeJSON.endsWith('=>') || beforeJSON.endsWith(':')) {
                                const formatted = JSON.stringify(parsed, null, 2);

                                if (beforeJSON.length > 0 && !beforeJSON.endsWith('\n')) {
                                    result += '\n';
                                }

                                result += formatted;
                                i = endIdx + 1;
                                continue;
                            }
                        } catch (e) {
                            // Continue
                        }
                    }
                }

                result += char;
                i++;
            }

            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(text.length)
            );

            await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, result);
            });

            // Now set the language to enable syntax highlighting
            await vscode.languages.setTextDocumentLanguage(document, 'ansible-output');

            vscode.window.showInformationMessage('Ansible output formatted and syntax highlighting applied!');

            // Auto-fold
            setTimeout(() => {
                vscode.commands.executeCommand('editor.foldAll');
            }, 200);

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    context.subscriptions.push(formatAndHighlightDisposable);
}

export function deactivate() {}