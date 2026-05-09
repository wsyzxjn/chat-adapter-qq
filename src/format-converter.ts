import { BaseFormatConverter, parseMarkdown, stringifyMarkdown } from "chat";

/**
 * QQ text format converter.
 *
 * QQ adapter currently uses markdown-compatible plain text, so conversion
 * is a direct markdown <-> AST transformation.
 */
export class QQFormatConverter extends BaseFormatConverter {
  /** Convert canonical AST into QQ outbound text payload. */
  fromAst(ast: ReturnType<typeof parseMarkdown>): string {
    return stringifyMarkdown(ast);
  }

  /** Parse QQ inbound text payload into canonical AST. */
  toAst(platformText: string): ReturnType<typeof parseMarkdown> {
    return parseMarkdown(platformText ?? "");
  }
}
