export {};

declare global {
  namespace BunWasm {
    interface TlsIdentityInternal {
      native: { domainToASCII(value: string): string };
      require(name: "net_address"): { isIP(value: string): 0 | 4 | 6 };
      require(name: "util"): { types: { isNativeError(value: unknown): value is Error } };
    }
    type TlsIdentityErrorCode = "ERR_INVALID_ARG_TYPE" | "ERR_INVALID_ARG_VALUE" | "ERR_TLS_CERT_ALTNAME_FORMAT" | "ERR_TLS_CERT_ALTNAME_INVALID" | "ERR_TLS_HOSTNAME_REQUIRED";
    interface TlsIdentityError extends Error { readonly code: TlsIdentityErrorCode; readonly reason?: string }
    interface TlsPeerCertificateSubject { readonly CN?: string | readonly string[] }
    interface TlsPeerCertificate { readonly subject?: TlsPeerCertificateSubject; readonly subjectaltname?: string }
    type TlsIdentityTarget =
      | { readonly kind: "dns"; readonly hostname: string; readonly servername: string }
      | { readonly kind: "ip"; readonly hostname: string; readonly servername: "" }
      | { readonly kind: "none"; readonly hostname: undefined; readonly servername: "" };
    interface TlsIdentityTargetOptions {
      readonly servername?: string;
      readonly connectHost?: string;
      readonly originalTarget?: string;
      readonly rejectUnauthorized: boolean;
    }
    type TlsCheckServerIdentity = (hostname: string, cert: TlsPeerCertificate) => Error | undefined;
    type TlsIdentityVerification =
      | { readonly chainVerified: false; readonly authorizationError: Error; readonly rejectUnauthorized: boolean }
      | {
          readonly chainVerified: true;
          readonly cert: TlsPeerCertificate;
          readonly target: TlsIdentityTarget;
          readonly rejectUnauthorized: boolean;
          readonly checkServerIdentity?: TlsCheckServerIdentity;
        };
    type TlsIdentityDecision =
      | { readonly kind: "authorized" }
      | { readonly kind: "unauthorized"; readonly authorizationError: Error }
      | { readonly kind: "rejected"; readonly authorizationError: Error };
    interface TlsIdentity {
      checkServerIdentity(hostname: unknown, cert: TlsPeerCertificate): TlsIdentityError | undefined;
      selectTarget(options: TlsIdentityTargetOptions): TlsIdentityTarget | TlsIdentityError;
      verifyIdentity(verification: TlsIdentityVerification): TlsIdentityDecision;
    }
    interface Internal { require(name: "tls_identity"): TlsIdentity }
  }
}
