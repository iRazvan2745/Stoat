const PNG_MAGIC = "iVBORw0KGgo";
const JPEG_MAGIC = "/9j/";
const GIF_MAGIC = "R0lGOD";
const WEBP_MAGIC = "UklGR";
const SVG_MAGIC = "PHN2Zy";
const XML_MAGIC = "PD94bW";
const BASE64_BODY = /^[A-Za-z0-9+/]+=*$/u;
const POSTGRES_FALLBACK_ICON = "/templates/postgresql/logo";

const inferBase64ImageType = (value: string): string => {
  if (value.startsWith(PNG_MAGIC)) {
    return "image/png";
  }

  if (value.startsWith(JPEG_MAGIC)) {
    return "image/jpeg";
  }

  if (value.startsWith(GIF_MAGIC)) {
    return "image/gif";
  }

  if (value.startsWith(WEBP_MAGIC)) {
    return "image/webp";
  }

  if (value.startsWith(SVG_MAGIC) || value.startsWith(XML_MAGIC)) {
    return "image/svg+xml";
  }

  return "image/png";
};

const isSafeHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const isSafeRelativeUrl = (value: string): boolean =>
  value.startsWith("/") && !value.startsWith("//");

export function serviceIconSrc(icon: string | null | undefined): string | null {
  const trimmed = icon?.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("data:image/")) {
    return trimmed;
  }

  if (isSafeRelativeUrl(trimmed) || isSafeHttpUrl(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replaceAll(/\s/gu, "");

  if (!BASE64_BODY.test(compact)) {
    return null;
  }

  return `data:${inferBase64ImageType(compact)};base64,${compact}`;
}

export function resolveServiceIcon(
  icon: string | null | undefined,
  type?: string | null,
): string | null {
  return serviceIconSrc(icon) ?? (type === "postgresql" ? POSTGRES_FALLBACK_ICON : null);
}
