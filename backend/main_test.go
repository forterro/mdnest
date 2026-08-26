package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestReapStaleZombies spawns a child deliberately left un-Wait()-ed (as a
// git subprocess can end up if nothing ever collects it), confirms it sits
// as a zombie, then verifies reapStaleZombies collects it without disturbing
// unrelated processes.
func TestReapStaleZombies(t *testing.T) {
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	// Deliberately never call cmd.Wait() — that's the scenario under test.

	deadline := time.Now().Add(2 * time.Second)
	for {
		state, ok := procState(t, pid)
		if ok && state == "Z" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child %d never became a zombie (state=%q ok=%v)", pid, state, ok)
		}
		time.Sleep(10 * time.Millisecond)
	}

	reapStaleZombies(os.Getpid())

	if _, ok := procState(t, pid); ok {
		t.Fatalf("pid %d still present in /proc after reapStaleZombies", pid)
	}
}

// procState reads the zombie/running state of pid from /proc, or ok=false if
// the entry is gone.
func procState(t *testing.T, pid int) (state string, ok bool) {
	t.Helper()
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", false
	}
	s := string(data)
	i := strings.LastIndexByte(s, ')')
	if i < 0 || i+2 >= len(s) {
		return "", false
	}
	fields := strings.Fields(s[i+2:])
	if len(fields) < 1 {
		return "", false
	}
	return fields[0], true
}
