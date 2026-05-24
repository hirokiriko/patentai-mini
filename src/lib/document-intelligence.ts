import DocumentIntelligence, {
  getLongRunningPoller,
  isUnexpected,
  type AnalyzeOperationOutput,
  type DocumentTableOutput,
} from "@azure-rest/ai-document-intelligence";

const DOCUMENT_INTELLIGENCE_MODEL_ID = "prebuilt-layout";

type DocumentIntelligenceConfig = {
  endpoint: string;
  key: string;
};

export function getDocumentIntelligenceMissingEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT) {
    missing.push("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
  }
  if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY) {
    missing.push("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  }
  return missing;
}

export function isDocumentIntelligenceConfigured(): boolean {
  return getDocumentIntelligenceMissingEnv().length === 0;
}

function getDocumentIntelligenceConfig(): DocumentIntelligenceConfig {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  const missing = getDocumentIntelligenceMissingEnv();

  if (!endpoint || !key || missing.length > 0) {
    throw new Error(
      `Azure Document Intelligence is not configured. Missing: ${missing.join(", ")}`
    );
  }

  return { endpoint, key };
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function formatTablesAsMarkdown(tables: DocumentTableOutput[] | undefined): string {
  if (!tables || tables.length === 0) {
    return "";
  }

  return tables
    .map((table, index) => {
      const rowCount = Math.max(table.rowCount, 1);
      const columnCount = Math.max(table.columnCount, 1);
      const rows = Array.from({ length: rowCount }, () =>
        Array.from({ length: columnCount }, () => "")
      );

      for (const cell of table.cells) {
        const content = escapeMarkdownCell(cell.content);
        rows[cell.rowIndex][cell.columnIndex] = content;
      }

      const [header = [], ...body] = rows;
      const separator = header.map(() => "---");
      const lines = [
        `Table ${index + 1}`,
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
      ];

      return lines.join("\n");
    })
    .join("\n\n");
}

function getDocumentIntelligenceErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const maybeError = error as {
    code?: unknown;
    message?: unknown;
    target?: unknown;
    details?: Array<{ message?: unknown }>;
    innererror?: { code?: unknown; message?: unknown; innererror?: unknown };
  };
  const code = typeof maybeError.code === "string" ? maybeError.code : null;
  const message =
    typeof maybeError.message === "string" ? maybeError.message : String(error);
  const target = typeof maybeError.target === "string" ? maybeError.target : null;
  const details = Array.isArray(maybeError.details)
    ? maybeError.details
        .map((detail) => detail.message)
        .filter((detail): detail is string => typeof detail === "string")
    : [];
  const innerMessages: string[] = [];
  let inner = maybeError.innererror;
  while (inner && typeof inner === "object") {
    const innerCode = typeof inner.code === "string" ? inner.code : null;
    const innerMessage = typeof inner.message === "string" ? inner.message : null;
    if (innerCode || innerMessage) {
      innerMessages.push([innerCode, innerMessage].filter(Boolean).join(": "));
    }
    inner = inner.innererror as typeof maybeError.innererror;
  }

  return [
    [code, message].filter(Boolean).join(": "),
    target ? `target=${target}` : null,
    details.length > 0 ? `details=${details.join("; ")}` : null,
    innerMessages.length > 0 ? `inner=${innerMessages.join(" > ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function extractTextWithDocumentIntelligence(
  buffer: Buffer
): Promise<string> {
  const { endpoint, key } = getDocumentIntelligenceConfig();
  const client = DocumentIntelligence(endpoint, { key });

  const initialResponse = await client
    .path("/documentModels/{modelId}:analyze", DOCUMENT_INTELLIGENCE_MODEL_ID)
    .post({
      contentType: "application/json",
      body: {
        base64Source: buffer.toString("base64"),
      },
      queryParameters: {
        outputContentFormat: "markdown",
      },
    });

  if (isUnexpected(initialResponse)) {
    throw new Error(getDocumentIntelligenceErrorMessage(initialResponse.body.error));
  }

  const poller = getLongRunningPoller(client, initialResponse);
  const result = (await poller.pollUntilDone()).body as AnalyzeOperationOutput;

  if (result.status !== "succeeded") {
    throw new Error(
      result.error
        ? getDocumentIntelligenceErrorMessage(result.error)
        : `Unexpected Document Intelligence status: ${result.status}`
    );
  }

  const analyzeResult = result.analyzeResult;
  const content = analyzeResult?.content?.trim() ?? "";
  const tables =
    analyzeResult?.contentFormat === "markdown"
      ? ""
      : formatTablesAsMarkdown(analyzeResult?.tables);

  return [content, tables].filter(Boolean).join("\n\n").trim();
}
