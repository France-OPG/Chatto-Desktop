package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"

	"golang.org/x/crypto/argon2"
)

// ServerEntry is one Chatto server the user is registered on.
type ServerEntry struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// Vault is the decrypted content of base.cd.
type Vault struct {
	Servers []ServerEntry `json:"servers"`
}

const (
	saltLen    = 16
	nonceLen   = 12
	kdfTime    = 1
	kdfMem     = 64 * 1024 // 64 MB
	kdfThreads = 4
	keyLen     = 32
)

var (
	errNoVault    = errors.New("aucun coffre ouvert")
	errIndexRange = errors.New("index de serveur invalide")
	errBadFile    = errors.New("fichier base.cd corrompu ou illisible")
	errBadPass    = errors.New("mot de passe incorrect ou fichier corrompu")
)

func deriveKey(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, kdfTime, kdfMem, kdfThreads, keyLen)
}

// encryptVault serializes the vault to JSON and encrypts it with a fresh
// random salt + nonce. Layout on disk: salt(16) | nonce(12) | ciphertext.
func encryptVault(v *Vault, password string) ([]byte, error) {
	plaintext, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}

	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key := deriveKey(password, salt)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	out := make([]byte, 0, saltLen+nonceLen+len(ciphertext))
	out = append(out, salt...)
	out = append(out, nonce...)
	out = append(out, ciphertext...)
	return out, nil
}

func decryptVault(data []byte, password string) (*Vault, error) {
	if len(data) < saltLen+nonceLen {
		return nil, errBadFile
	}
	salt := data[:saltLen]
	nonce := data[saltLen : saltLen+nonceLen]
	ciphertext := data[saltLen+nonceLen:]

	key := deriveKey(password, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errBadPass
	}

	var v Vault
	if err := json.Unmarshal(plaintext, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func saveVaultFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0o600)
}

func loadVaultFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func baseFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
