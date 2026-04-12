//go:build js && wasm

package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"

	"encoding/hex"

	"syscall/js"

	"fmt"
	"io"
)

func getEncryptionKey(phrase string) [32]byte {
	h := sha256.New()
	h.Write([]byte(phrase))
	var res [32]byte
	copy(res[:], h.Sum(nil))
	return res
}

func encrypt(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return js.ValueOf(map[string]any{"error": "Missing key phrase"})
	}

	text := []byte(args[0].String())
	phrase := args[1].String()
	key := getEncryptionKey(phrase)

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return js.ValueOf(map[string]any{"error": err.Error()})
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return js.ValueOf(map[string]any{"error": err.Error()})
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return js.ValueOf(map[string]any{"error": err.Error()})
	}

	res := aesGCM.Seal(nonce, nonce, text, nil)

	return js.ValueOf(map[string]any{
		"result": hex.EncodeToString(res),
	})

}

func decrypt(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return js.ValueOf(map[string]any{"error": "Missing key phrase"})
	}

	ciphertext, err := hex.DecodeString(args[0].String())
	if err != nil {
		return js.ValueOf(map[string]any{"error": "Failed to decode message"})
	}
	phrase := args[1].String()
	key := getEncryptionKey(phrase)

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return js.ValueOf(map[string]any{"error": "Failed to create cipher"})
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return js.ValueOf(map[string]any{"error": "Failed to initiate GCM"})
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return js.ValueOf(map[string]any{"error": "cipher too short"})
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	text, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return js.ValueOf(map[string]any{"error": "Failed to decrypt, wrong decryption key"})
	}

	return js.ValueOf(map[string]any{
		"result": string(text),
	})
}

func main() {
	c := make(chan struct{})
	js.Global().Set("AESEncrypt", js.FuncOf(encrypt))
	js.Global().Set("AESDecrypt", js.FuncOf(decrypt))
	fmt.Println("WASM crypto module loaded")
	<-c
}
