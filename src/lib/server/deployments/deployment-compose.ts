// oxlint-disable func-style
import YAML, { isMap, isScalar } from "yaml";

export interface FormattedCompose {
  serviceCount: number;
  serviceNames: string[];
  yaml: string;
}

export function formatComposeFile(compose: string, serviceSlug: string): FormattedCompose {
  const doc = YAML.parseDocument(compose);

  if (doc.errors.length > 0) {
    throw new Error("Invalid compose YAML");
  }

  const serviceMap = doc.get("services", true);

  if (!isMap(serviceMap)) {
    throw new Error('Compose must contain a "services" map');
  }

  const serviceNames: string[] = [];

  for (const pair of serviceMap.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error("Invalid service name");
    }

    const serviceName = `${serviceSlug}-${pair.key.value}`;
    pair.key.value = serviceName;
    serviceNames.push(serviceName);
  }

  return {
    serviceCount: serviceNames.length,
    serviceNames,
    yaml: doc.toString(),
  };
}
