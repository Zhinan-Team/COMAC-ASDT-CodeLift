import { getLastNPathParts } from "../../util";
import {
  AutocompleteClipboardSnippet,
  AutocompleteCodeSnippet,
  AutocompleteDiffSnippet,
  AutocompleteSnippet,
  AutocompleteSnippetType,
} from "../snippets/types";
import { HelperVars } from "../util/HelperVars";

const getCommentMark = (helper: HelperVars) => {
  return helper.lang.singleLineComment;
};

const addCommentMarks = (text: string, helper: HelperVars) => {
  const lines = [
    ...text
      .trim()
      .split("\n")
      .map((line) => `${getCommentMark(helper)} ${line}`),
  ];
  return lines.join("\n");
};

const formatClipboardSnippet = (
  snippet: AutocompleteClipboardSnippet,
): AutocompleteCodeSnippet => {
  return formatCodeSnippet({
    filepath: "Untitled.txt",
    content: snippet.content,
    type: AutocompleteSnippetType.Code,
  });
};

const formatCodeSnippet = (
  snippet: AutocompleteCodeSnippet,
): AutocompleteCodeSnippet => {
  return {
    ...snippet,
    content: `Path: ${getLastNPathParts(snippet.filepath, 2)}\n${snippet.content}`,
  };
};

const formatDiffSnippet = (
  snippet: AutocompleteDiffSnippet,
): AutocompleteDiffSnippet => {
  return snippet;
};

const getCurrentFilepath = (helper: HelperVars) => {
  return getLastNPathParts(helper.filepath, 2);
};

const commentifySnippet = (
  helper: HelperVars,
  snippet: AutocompleteSnippet,
): AutocompleteSnippet => {
  return {
    ...snippet,
    content: addCommentMarks(snippet.content, helper),
  };
};

const SNIPPET_TYPES_TO_COMMENT = [
  AutocompleteSnippetType.Code,
  AutocompleteSnippetType.Clipboard,
];

export const formatSnippets = (
  helper: HelperVars,
  snippets: AutocompleteSnippet[],
): string => {
  const currentFilepathComment = addCommentMarks(
    getCurrentFilepath(helper),
    helper,
  );

  return (
    snippets
      .map((snippet) => {
        switch (snippet.type) {
          case AutocompleteSnippetType.Code:
            return formatCodeSnippet(snippet);
          case AutocompleteSnippetType.Diff:
            return formatDiffSnippet(snippet);
          case AutocompleteSnippetType.Clipboard:
            return formatClipboardSnippet(snippet);
        }
      })
      .map((item) => {
        if (SNIPPET_TYPES_TO_COMMENT.includes(item.type)) {
          return commentifySnippet(helper, item);
        }

        return item;
      })
      .map((item) => {
        if (SNIPPET_TYPES_TO_COMMENT.includes(item.type)) {
          const commentMark = getCommentMark(helper);
          return item.content + `\n${commentMark}\n${commentMark}`;
        }

        return item.content;
      })
      .join("\n") + `\n${currentFilepathComment}`
  );
};
