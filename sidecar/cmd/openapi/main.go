package main

import (
	"fmt"
	"os"

	"git.irazz.lol/stoat/sidecar/internal/httpapi"
)

func main() {
	document, err := httpapi.OpenAPIDocumentJSON()
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate OpenAPI document: %v\n", err)
		os.Exit(1)
	}
	if _, err = os.Stdout.Write(document); err != nil {
		fmt.Fprintf(os.Stderr, "write OpenAPI document: %v\n", err)
		os.Exit(1)
	}
}
