package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCommandDefaults(t *testing.T) {
	command := newCommand()
	assert.Equal(t, "127.0.0.1:8080", command.Flag("listen").Value.String())
	assert.Equal(t, defaultConfigPath, command.Flag("uncloud-config").Value.String())
	assert.Equal(t, "http://localhost:3000,http://localhost:5173", command.Flag("cors-origins").Value.String())
}
