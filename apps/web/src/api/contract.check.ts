// Compile-time only: fails `tsc` when apps/web's wire types drift from the
// server's. Never imported at runtime, so Vite does not bundle it.
import type * as Http from "../../../../services/api/src/lib/http";
import type * as Server from "../../../../services/api/src/types/api";
import type * as Web from "./types";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const contractChecks: [
  Same<Web.User, Server.User>,
  Same<Web.SignInResponse, Server.SignInResponse>,
  Same<Web.MeResponse, Server.MeResponse>,
  Same<Web.AppleSignInRequest, Server.AppleSignInRequest>,
  Same<Web.EmailStartRequest, Server.EmailStartRequest>,
  Same<Web.EmailVerifyRequest, Server.EmailVerifyRequest>,
  Same<Web.Package, Server.Package>,
  Same<Web.PackageItem, Server.PackageItem>,
  Same<Web.PackageEvent, Server.PackageEvent>,
  Same<Web.PackagePutRequest, Server.PackagePutRequest>,
  Same<Web.PackageResponse, Server.PackageResponse>,
  Same<Web.PackageDeleteResponse, Server.PackageDeleteResponse>,
  Same<Web.SessionInfo, Server.SessionInfo>,
  Same<Web.SessionsResponse, Server.SessionsResponse>,
  Same<Web.SessionDeleteResponse, Server.SessionDeleteResponse>,
  Same<Web.RefreshResponse, Server.RefreshResponse>,
  Same<Web.SyncResponse, Server.SyncResponse>,
  Same<Web.PairingStartResponse, Server.PairingStartResponse>,
  Same<Web.TokensResponse, Server.TokensResponse>,
  Same<Web.ErrorCode, Http.ErrorCode>,
  Same<Web.ApiErrorBody, Http.ApiError>,
  Same<Web.Envelope<unknown>, Http.Envelope<unknown>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
