package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/psviderski/uncloud/pkg/api"
)

const machineExecEventBufferSize = 32

type machineExecStreamWriter struct {
	ctx       context.Context
	events    chan<- MachineExecEvent
	eventType string
}

func (w *machineExecStreamWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}

	event := MachineExecEvent{Type: w.eventType, Data: string(data)}
	select {
	case w.events <- event:
		return len(data), nil
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	}
}

func (s *Server) execMachine(c *fiber.Ctx) error {
	request, err := decodeMachineExecRequest(c)
	if err != nil {
		return writeError(c, err)
	}

	machine, err := s.resolveMachineExecTarget(c)
	if err != nil {
		return writeError(c, err)
	}

	stdout := &cappedBuffer{limit: maxExecOutputBytes}
	stderr := &cappedBuffer{limit: maxExecOutputBytes}
	exitCode, err := s.backend.ExecMachine(
		requestContext(c), machine.ID, machineExecOptions(request, stdout, stderr),
	)
	if err != nil {
		return writeError(c, err)
	}

	return c.JSON(MachineExecResponse{
		MachineID:   machine.ID,
		MachineName: machine.Name,
		ExitCode:    exitCode,
		Stdout:      stdout.String(),
		Stderr:      stderr.String(),
		Truncated:   stdout.Truncated() || stderr.Truncated(),
	})
}

func (s *Server) streamMachineExec(c *fiber.Ctx) error {
	request, err := decodeMachineExecRequest(c)
	if err != nil {
		return writeError(c, err)
	}

	machine, err := s.resolveMachineExecTarget(c)
	if err != nil {
		return writeError(c, err)
	}

	streamContext, cancel := context.WithCancel(requestContext(c))
	events := make(chan MachineExecEvent, machineExecEventBufferSize)
	go func() {
		defer close(events)

		stdout := &machineExecStreamWriter{
			ctx: streamContext, events: events, eventType: "stdout",
		}
		stderr := &machineExecStreamWriter{
			ctx: streamContext, events: events, eventType: "stderr",
		}
		exitCode, execErr := s.backend.ExecMachine(
			streamContext, machine.ID, machineExecOptions(request, stdout, stderr),
		)
		if execErr != nil {
			emitMachineExecEvent(streamContext, events, MachineExecEvent{
				Type: "error", Error: execErr.Error(),
			})
			return
		}

		emitMachineExecEvent(streamContext, events, MachineExecEvent{
			Type: "complete", ExitCode: &exitCode,
		})
	}()

	c.Set(fiber.HeaderContentType, "text/event-stream")
	c.Set(fiber.HeaderCacheControl, "no-cache")
	c.Set("X-Accel-Buffering", "no")
	requestDone := c.Context().Done()
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer cancel()
		for {
			select {
			case event, ok := <-events:
				if !ok {
					return
				}
				if err := writeMachineExecEvent(writer, event); err != nil {
					return
				}
			case <-requestDone:
				return
			}
		}
	})
	return nil
}

func decodeMachineExecRequest(c *fiber.Ctx) (MachineExecRequest, error) {
	var request MachineExecRequest
	if err := decodeJSON(c, &request); err != nil {
		return request, err
	}
	if len(request.Command) == 0 {
		return request, fiber.NewError(fiber.StatusBadRequest, "command must not be empty")
	}
	for _, argument := range request.Command {
		if strings.ContainsRune(argument, '\x00') {
			return request, fiber.NewError(fiber.StatusBadRequest, "command arguments must not contain NUL bytes")
		}
	}
	return request, nil
}

func (s *Server) resolveMachineExecTarget(c *fiber.Ctx) (api.MachineMember, error) {
	machineSelector := strings.TrimSpace(c.Params("id"))
	if machineSelector == "" {
		return api.MachineMember{}, fiber.NewError(fiber.StatusBadRequest, "machine identifier must not be empty")
	}

	machine, err := s.backend.InspectMachine(requestContext(c), machineSelector)
	if err != nil {
		return api.MachineMember{}, err
	}
	if strings.TrimSpace(machine.ID) == "" {
		return api.MachineMember{}, errors.New("Uncloud returned an empty machine response")
	}
	return machine, nil
}

func machineExecOptions(request MachineExecRequest, stdout, stderr io.Writer) api.ExecOptions {
	var stdin io.Reader
	if request.Stdin != "" {
		stdin = strings.NewReader(request.Stdin)
	}

	return api.ExecOptions{
		Command:      request.Command,
		AttachStdin:  stdin != nil,
		AttachStdout: true,
		AttachStderr: true,
		Stdin:        stdin,
		Stdout:       stdout,
		Stderr:       stderr,
	}
}

func emitMachineExecEvent(ctx context.Context, events chan<- MachineExecEvent, event MachineExecEvent) bool {
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func writeMachineExecEvent(writer *bufio.Writer, event MachineExecEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", event.Type, data); err != nil {
		return err
	}
	return writer.Flush()
}
