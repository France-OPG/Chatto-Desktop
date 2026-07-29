package main

import (
	"context"
	"os"
	"path/filepath"
)

// App is bound to the frontend via Wails. Every exported method below is
// callable from JS as window.go.main.App.<MethodName>(...).
type App struct {
	ctx      context.Context
	vault    *Vault
	basePath string
}

func NewApp() *App {
	exe, err := os.Executable()
	dir := "."
	if err == nil {
		dir = filepath.Dir(exe)
	}
	return &App{
		basePath: filepath.Join(dir, "base.cd"),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// HasExistingBase reports whether base.cd already sits next to the executable.
func (a *App) HasExistingBase() bool {
	return baseFileExists(a.basePath)
}

// CreateBase creates a brand new empty encrypted vault at base.cd.
func (a *App) CreateBase(password string) string {
	v := &Vault{Servers: []ServerEntry{}}
	data, err := encryptVault(v, password)
	if err != nil {
		return err.Error()
	}
	if err := saveVaultFile(a.basePath, data); err != nil {
		return err.Error()
	}
	a.vault = v
	return ""
}

// OpenBase decrypts the base.cd sitting next to the executable.
func (a *App) OpenBase(password string) string {
	data, err := loadVaultFile(a.basePath)
	if err != nil {
		return err.Error()
	}
	v, err := decryptVault(data, password)
	if err != nil {
		return err.Error()
	}
	a.vault = v
	return ""
}

// ImportBase opens a base.cd file from an arbitrary path, then copies it
// next to the executable so it auto-loads on the next launch.
func (a *App) ImportBase(sourcePath, password string) string {
	data, err := loadVaultFile(sourcePath)
	if err != nil {
		return err.Error()
	}
	v, err := decryptVault(data, password)
	if err != nil {
		return err.Error()
	}
	a.vault = v
	if err := saveVaultFile(a.basePath, data); err != nil {
		return err.Error()
	}
	return ""
}

func (a *App) persist(password string) error {
	data, err := encryptVault(a.vault, password)
	if err != nil {
		return err
	}
	return saveVaultFile(a.basePath, data)
}

// AddServer appends a new server entry and re-encrypts the vault on disk.
// vaultPassword is required again here since we never keep the password in memory.
func (a *App) AddServer(name, url, username, serverPassword, vaultPassword string) string {
	if a.vault == nil {
		return errNoVault.Error()
	}
	a.vault.Servers = append(a.vault.Servers, ServerEntry{
		Name:     name,
		URL:      url,
		Username: username,
		Password: serverPassword,
	})
	if err := a.persist(vaultPassword); err != nil {
		return err.Error()
	}
	return ""
}

// RemoveServer deletes a server entry by index and re-encrypts the vault.
func (a *App) RemoveServer(index int, vaultPassword string) string {
	if a.vault == nil {
		return errNoVault.Error()
	}
	if index < 0 || index >= len(a.vault.Servers) {
		return errIndexRange.Error()
	}
	a.vault.Servers = append(a.vault.Servers[:index], a.vault.Servers[index+1:]...)
	if err := a.persist(vaultPassword); err != nil {
		return err.Error()
	}
	return ""
}

// ListServers returns the servers in the currently opened vault (never includes
// the vault password itself — only per-server credentials the user typed in).
func (a *App) ListServers() []ServerEntry {
	if a.vault == nil {
		return []ServerEntry{}
	}
	return a.vault.Servers
}

// ExportBase copies the encrypted base.cd (as-is, still encrypted) to destPath.
func (a *App) ExportBase(destPath string) string {
	data, err := loadVaultFile(a.basePath)
	if err != nil {
		return err.Error()
	}
	if err := saveVaultFile(destPath, data); err != nil {
		return err.Error()
	}
	return ""
}
