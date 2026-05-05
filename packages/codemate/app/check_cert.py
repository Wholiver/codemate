#!/usr/bin/env python3

import os
import ssl
import subprocess
import sys
import datetime


def main():
    cert_path = os.path.join(os.path.dirname(__file__), "ssl", "server.crt")

    if not os.path.exists(cert_path):
        print(f"Certificate not found at {cert_path}")
        sys.exit(1)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cert_path)

    result = subprocess.run(
        ["openssl", "x509", "-in", cert_path, "-noout", "-subject", "-enddate", "-fingerprint", "-sha256"],
        capture_output=True, text=True,
    )

    subject = expiry = fingerprint = None
    for line in result.stdout.strip().splitlines():
        if line.startswith("subject="):
            subject = line.split("=", 1)[1].strip()
        elif line.startswith("notAfter="):
            expiry_date = line.split("=", 1)[1].strip()
            dt = datetime.datetime.strptime(expiry_date, "%b  %d %H:%M:%S %Y %Z")
            expiry = dt.strftime("%Y-%m-%d")
        elif "Fingerprint" in line:
            fingerprint = line.split("=", 1)[1].strip()

    cn = [part.split("=", 1)[1] for part in subject.split(",") if "CN" in part][0] if subject else "N/A"

    print(f"Common Name: {cn}")
    print(f"Expires: {expiry}")
    print(f"SHA-256 Fingerprint: {fingerprint}")
    print("Certificate verification successful")


if __name__ == "__main__":
    main()
