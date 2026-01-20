package helpers

import (
	"os"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"crypto/rsa"
	"crypto/rand"

	"encoding/pem"

	"math/big"
	"time"
	"net"
	"errors"

	"log"
)

func GenerateSelfSignedCertificateForIP(ip string) (*tls.Certificate, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)

	if err != nil {
		log.Fatalln("Error Generating RSA keypair", err)
		return nil, err
	}

	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return nil, errors.New("invalid IP address")
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name {
			Organization: []string{"EMSG self-signed"},
		},
		NotBefore: time.Now(),
		NotAfter: time.Now().AddDate(1, 0, 0),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{parsedIP},
		BasicConstraintsValid: true,
		IsCA: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
	if err != nil {
		log.Fatalln("Error Generating x509 certificate", err)
		return nil, err
	}

	var certPEM bytes.Buffer
	if err = pem.Encode(&certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		log.Fatalln("Error converting certificate to PEM", err)
		return nil, err
	}

	certBytes := certPEM.Bytes()

	var keyPEM bytes.Buffer
	if err := pem.Encode(&keyPEM,
		&pem.Block{
			Type:  "RSA PRIVATE KEY",
			Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
		},
	); err != nil {
		log.Println("Error PEM encoding private key:", err)
		return nil, err
	}

	certificate, err := tls.X509KeyPair(certBytes, keyPEM.Bytes())
	if err != nil {
		log.Fatalln("Failed to generate TLS Key Pair", err)
		return nil, err
	}

	return &certificate, nil
	// return []tls.Certificate{certificate}, nil
	// tlsConfig := &tls.Config {
	// 	Certificates: []tls.Certificate{certificate},
	// 	PrivateKey: privateKey,
	// 	CurvePreferences: []uint16{tls.CurveP256, tls.CurveP384, tls.CurveP521},
	// 	MinVersion: tls.VersionTLS12,
	// }
	//
	// return tlsConfig
}


func GetCertificate() (*tls.Certificate, error) {

	TLS_ENABLED := os.Getenv("TLS_ENABLED")

	if TLS_ENABLED != "true" {
		return nil, nil
	}

	TLS_STRATEGY := os.Getenv("TLS_STRATEGY")
	if TLS_STRATEGY == "load" {
		cert, err := tls.LoadX509KeyPair("cert.pem", "key.pem")
		if err != nil {
			log.Fatalln("Failed to load certificates, please put cert.pem and key.pem next in the working directory", err)
			return nil, err
		}

		return &cert, nil
	} else if TLS_STRATEGY == "generate" {
		TLS_DOMAIN := os.Getenv("TLS_DOMAIN")

		certificates, err := GenerateSelfSignedCertificateForIP(TLS_DOMAIN)

		if err != nil {
			log.Fatalln("Failed to generate certificate", err)
			return nil, err
		}
		return certificates, nil
	} 

	return nil, errors.New("No certificate loading method specified, use 'genreate' or 'load' in TLS_STRATEGY")
}
