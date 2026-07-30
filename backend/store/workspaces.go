package store

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/secrets"
)

// PersonalNamespace derives a user's personal-workspace namespace from their
// id: stable, collision-free and never user-controlled. Its owner has implicit
// read/write access (the authz layer special-cases it), so it is excluded from
// the grants model.
func PersonalNamespace(userID int) string { return "user-" + strconv.Itoa(userID) }

// Workspace is the per-namespace git remote configuration exposed to API
// clients. It carries only metadata — never the stored credential. HasCredential
// reports whether a PAT / SSH key is on file so the UI can show "configured"
// without ever reading the secret back.
type Workspace struct {
	ID            int       `json:"id"`
	Namespace     string    `json:"namespace"`
	OwnerID       *int      `json:"owner_id,omitempty"`    // nil = shared/team workspace
	OwnerEmail    string    `json:"owner_email,omitempty"` // resolved via join, for admin UIs
	IsPersonal    bool      `json:"is_personal"`
	GitEnabled    bool      `json:"git_enabled"`
	Transport     string    `json:"transport"` // "https" | "ssh"
	RemoteURL     string    `json:"remote_url"`
	Username      string    `json:"username"`
	Branch        string    `json:"branch"`
	KnownHosts    string    `json:"known_hosts,omitempty"` // SSH host keys (public), not a secret
	HasCredential bool      `json:"has_credential"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// WorkspaceRemote is the decrypted per-namespace remote used by the git backend
// resolver. It is never serialised to a client — only handed to the committer
// to build a push. Credential is the plaintext PAT (https) or SSH private key.
type WorkspaceRemote struct {
	Namespace  string
	Transport  string
	RemoteURL  string
	Username   string
	Branch     string
	KnownHosts string
	Credential string
}

// WorkspaceInput carries the writable fields of a workspace. Credential is the
// plaintext PAT or SSH private key: nil leaves the stored credential unchanged
// (on update) or stores none (on create); a non-nil pointer replaces it.
type WorkspaceInput struct {
	Namespace  string
	OwnerID    *int
	IsPersonal bool
	GitEnabled bool
	Transport  string
	RemoteURL  string
	Username   string
	Branch     string
	KnownHosts string
	Credential *string
}

// WorkspaceStore persists per-workspace git remote configuration in the
// workspaces table (multi mode only). Credentials are sealed at rest with
// AES-256-GCM (see backend/secrets); the encryption key is derived once from an
// operator secret at construction.
type WorkspaceStore interface {
	List() ([]Workspace, error)
	Get(id int) (*Workspace, error)
	GetByNamespace(ns string) (*Workspace, error)
	GetPersonalByOwner(ownerID int) (*Workspace, error)
	Create(in WorkspaceInput) (*Workspace, error)
	Update(id int, in WorkspaceInput) (*Workspace, error)
	Delete(id int) (bool, error)
	// RemoteForNamespace returns the decrypted, git-enabled remote for a
	// namespace, or (nil, nil) when the namespace has no configured override.
	RemoteForNamespace(ns string) (*WorkspaceRemote, error)
}

// PostgresWorkspaceStore is the Postgres-backed WorkspaceStore.
type PostgresWorkspaceStore struct {
	db  *DB
	key [32]byte
}

// NewPostgresWorkspaceStore builds a workspace store whose credentials are
// sealed with a key derived from secret (SHA-256 → AES-256).
func NewPostgresWorkspaceStore(db *DB, secret string) *PostgresWorkspaceStore {
	return &PostgresWorkspaceStore{db: db, key: secrets.DeriveKey(secret)}
}

const workspaceSelect = `
	SELECT w.id, w.namespace, w.owner_id, COALESCE(u.email, ''), w.is_personal,
	       w.git_enabled, w.transport, w.remote_url, w.username, w.branch,
	       w.known_hosts, (w.credential_encrypted <> '') AS has_credential,
	       w.created_at, w.updated_at
	FROM workspaces w
	LEFT JOIN users u ON u.id = w.owner_id`

func (s *PostgresWorkspaceStore) List() ([]Workspace, error) {
	rows, err := s.db.Query(workspaceSelect + ` ORDER BY w.namespace`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Workspace, 0)
	for rows.Next() {
		w, err := scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *PostgresWorkspaceStore) Get(id int) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.id = $1`, id)
}

func (s *PostgresWorkspaceStore) GetByNamespace(ns string) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.namespace = $1`, ns)
}

func (s *PostgresWorkspaceStore) GetPersonalByOwner(ownerID int) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.owner_id = $1 AND w.is_personal`, ownerID)
}

func (s *PostgresWorkspaceStore) getOne(query string, args ...any) (*Workspace, error) {
	w, err := scanWorkspace(s.db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (s *PostgresWorkspaceStore) Create(in WorkspaceInput) (*Workspace, error) {
	in = normalizeInput(in)
	enc := ""
	if in.Credential != nil && *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt credential: %w", err)
		}
	}
	var id int
	err := s.db.QueryRow(
		`INSERT INTO workspaces
		   (namespace, owner_id, is_personal, git_enabled, transport,
		    remote_url, username, branch, known_hosts, credential_encrypted)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id`,
		in.Namespace, in.OwnerID, in.IsPersonal, in.GitEnabled, in.Transport,
		in.RemoteURL, in.Username, in.Branch, in.KnownHosts, enc,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *PostgresWorkspaceStore) Update(id int, in WorkspaceInput) (*Workspace, error) {
	in = normalizeInput(in)
	// Credential is updated only when a new plaintext value is supplied, so an
	// edit that leaves the field blank keeps the stored secret.
	if in.Credential == nil {
		_, err := s.db.Exec(
			`UPDATE workspaces SET
			   git_enabled = $2, transport = $3, remote_url = $4, username = $5,
			   branch = $6, known_hosts = $7, updated_at = now()
			 WHERE id = $1`,
			id, in.GitEnabled, in.Transport, in.RemoteURL, in.Username,
			in.Branch, in.KnownHosts,
		)
		if err != nil {
			return nil, err
		}
		return s.Get(id)
	}
	enc := ""
	if *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt credential: %w", err)
		}
	}
	_, err := s.db.Exec(
		`UPDATE workspaces SET
		   git_enabled = $2, transport = $3, remote_url = $4, username = $5,
		   branch = $6, known_hosts = $7, credential_encrypted = $8, updated_at = now()
		 WHERE id = $1`,
		id, in.GitEnabled, in.Transport, in.RemoteURL, in.Username,
		in.Branch, in.KnownHosts, enc,
	)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *PostgresWorkspaceStore) Delete(id int) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM workspaces WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *PostgresWorkspaceStore) RemoteForNamespace(ns string) (*WorkspaceRemote, error) {
	var (
		r   WorkspaceRemote
		enc string
	)
	r.Namespace = ns
	err := s.db.QueryRow(
		`SELECT transport, remote_url, username, branch, known_hosts, credential_encrypted
		 FROM workspaces
		 WHERE namespace = $1 AND git_enabled AND remote_url <> ''`, ns,
	).Scan(&r.Transport, &r.RemoteURL, &r.Username, &r.Branch, &r.KnownHosts, &enc)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if enc != "" {
		cred, err := secrets.Decrypt(enc, s.key)
		if err != nil {
			return nil, fmt.Errorf("decrypt credential for %q: %w", ns, err)
		}
		r.Credential = string(cred)
	}
	return &r, nil
}

// normalizeInput applies the column defaults so callers may leave transport /
// username / branch blank.
func normalizeInput(in WorkspaceInput) WorkspaceInput {
	if in.Transport = strings.ToLower(strings.TrimSpace(in.Transport)); in.Transport != "ssh" {
		in.Transport = "https"
	}
	if strings.TrimSpace(in.Username) == "" {
		in.Username = "oauth2"
	}
	if strings.TrimSpace(in.Branch) == "" {
		in.Branch = "main"
	}
	return in
}

// scanWorkspace reads a workspace row (rowScanner is declared in tokens.go and
// satisfied by both *sql.Row and *sql.Rows).
func scanWorkspace(row rowScanner) (Workspace, error) {
	var w Workspace
	var ownerID sql.NullInt64
	if err := row.Scan(
		&w.ID, &w.Namespace, &ownerID, &w.OwnerEmail, &w.IsPersonal,
		&w.GitEnabled, &w.Transport, &w.RemoteURL, &w.Username, &w.Branch,
		&w.KnownHosts, &w.HasCredential, &w.CreatedAt, &w.UpdatedAt,
	); err != nil {
		return Workspace{}, err
	}
	if ownerID.Valid {
		id := int(ownerID.Int64)
		w.OwnerID = &id
	}
	return w, nil
}
