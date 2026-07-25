import { Stack, Duration, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * ScubaSwap: static SPA + RP signing endpoint, behind one CloudFront
 * distribution.
 *
 * The single-distribution shape is deliberate. Putting the SPA and `/api/*` on
 * one origin means there is **no CORS** in production, one TLS certificate, and
 * one domain to point at the demo. Exposing API Gateway directly would need CORS
 * config on both sides and a second hostname.
 *
 * Deploy in **us-east-1**. CloudFront requires its ACM certificate there, and
 * keeping the whole stack in one region avoids a cross-region certificate dance
 * that is not worth the complexity here.
 */
export class ScubaSwapStack extends Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const domainName = this.node.tryGetContext("domainName") || undefined;
    // Two ways to get a certificate. If the domain is in Route53, name the zone
    // and the stack issues + DNS-validates one and writes the alias records
    // itself. Otherwise pass a pre-existing us-east-1 certificate ARN.
    const hostedZoneName = this.node.tryGetContext("hostedZoneName") || undefined;
    const certificateArn = this.node.tryGetContext("certificateArn") || undefined;
    const allowedActions = this.node.tryGetContext("allowedActions") || "scubaswap-connect";
    const rpId = this.node.tryGetContext("rpId") || "";

    // ---------------------------------------------------------------- secret
    // Created empty on purpose. The signing key is pasted in out-of-band, so it
    // never appears in this template, in git, or in CloudFormation history —
    // which is exactly what would happen if it were a Lambda env var.
    const signingKey = new secrets.Secret(this, "RpSigningKey", {
      secretName: "scubaswap/rp-signing-key",
      description:
        "World ID RP signing key. Set with: aws secretsmanager put-secret-value " +
        "--secret-id scubaswap/rp-signing-key --secret-string '0x<64 hex>'",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------- lambda
    const signer = new lambda.Function(this, "RpSigner", {
      runtime: lambda.Runtime.NODEJS_22_X,
      // The asset root is backend/, so the handler path includes src/.
      handler: "src/handler.handler",
      code: lambda.Code.fromAsset(join(here, "..", "..", "backend"), {
        // Excludes are matched at EVERY path depth, not anchored to the asset
        // root. A bare "test" here also deleted node_modules/viem/_esm/actions/
        // test/, which viem's barrel export imports — breaking the module graph
        // at cold start with ERR_MODULE_NOT_FOUND. Only extension patterns that
        // ESM resolution can never follow are safe to strip.
        //
        // `.d.ts` alone is ~39MB of the tree and is pure TypeScript metadata;
        // `.map` files are only read when a stack trace is symbolised.
        exclude: ["*.d.ts", "*.d.ts.map", "*.map", "*.md"],
      }),
      // The bundled code lives under backend/src, so point the handler there.
      // Kept explicit rather than restructuring the package for the deployer.
      environment: {
        RP_SIGNING_KEY_SECRET_ID: signingKey.secretName,
        ALLOWED_ACTIONS: allowedActions,
        RP_ID: rpId,
        NODE_OPTIONS: "--enable-source-maps",
      },
      timeout: Duration.seconds(10),
      memorySize: 512,
      // Signing is pure CPU on a 32-byte key; the default 1024 is wasteful and
      // 512 already covers a cold start plus one Secrets Manager fetch.
      logGroup: new logs.LogGroup(this, "RpSignerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      description: "Signs World ID proof requests for ScubaSwap",
    });
    signingKey.grantRead(signer);

    const api = new apigw.HttpApi(this, "Api", {
      apiName: "scubaswap-rp-signing",
      // No CORS block: in production the SPA is same-origin behind CloudFront,
      // and the local dev server handles its own CORS.
      createDefaultStage: true,
    });

    api.addRoutes({
      // Path matches the frontend call exactly, so CloudFront forwards without
      // rewriting. A rewrite would be one more thing to get subtly wrong.
      path: "/api/rp-signature",
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("SignerIntegration", signer),
    });

    // Throttle: this endpoint lends out our RP identity, so an open firehose is
    // a reputational risk, not just a cost one.
    const stage = api.defaultStage.node.defaultChild;
    stage.addPropertyOverride("DefaultRouteSettings", {
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    });

    // ------------------------------------------------------------- spa bucket
    const site = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ------------------------------------------------------------ cloudfront
    const apiOrigin = new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    let hostedZone;
    let certificate;
    if (hostedZoneName) {
      hostedZone = route53.HostedZone.fromLookup(this, "Zone", { domainName: hostedZoneName });
      // Issued in this stack, which is why the stack must be us-east-1:
      // CloudFront will only accept a certificate from that region.
      certificate = new acm.Certificate(this, "SiteCert", {
        domainName: domainName ?? hostedZoneName,
        subjectAlternativeNames: [`www.${domainName ?? hostedZoneName}`],
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    } else if (certificateArn) {
      certificate = acm.Certificate.fromCertificateArn(this, "Cert", certificateArn);
    }

    const aliases = certificate ? [domainName ?? hostedZoneName, `www.${domainName ?? hostedZoneName}`] : undefined;

    // SPA routing is done with a viewer-request function, NOT with the
    // distribution's `errorResponses`. Custom error responses apply to the whole
    // distribution rather than per behaviour, so mapping 403/404 to /index.html
    // also swallowed the API's own 403s and 404s: a request for a non-allowlisted
    // action came back as S3's AccessDenied XML instead of
    // {"error":"action_not_allowed"}, and the frontend could never read it.
    const spaRouting = new cloudfront.Function(this, "SpaRouting", {
      comment: "Rewrite extensionless paths to /index.html for client-side routing",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Never touch the API. This function is only attached to the default
  // behaviour, so this is belt-and-braces.
  if (uri.indexOf('/api/') === 0) return request;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // No dot in the last segment means it is a route, not an asset.
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) request.uri = '/index.html';

  return request;
}
      `),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "ScubaSwap",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRouting, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // CACHING_DISABLED is load-bearing, not tidiness. Every response
          // carries a single-use nonce for World ID's replay protection; a
          // cached one would be handed to every subsequent caller. The handler
          // also sets `no-store`, deliberately belt-and-braces, because either
          // control alone fails silently and open.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Host must remain the API Gateway hostname or the request will not
          // route; this managed policy forwards everything except Host.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      ...(certificate ? { domainNames: aliases, certificate } : {}),
    });

    // Alias records for both apex and www. A and AAAA: CloudFront is dual-stack,
    // and an IPv6-only client with no AAAA record simply cannot reach the site.
    if (hostedZone) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      for (const [label, recordName] of [["Apex", undefined], ["Www", "www"]]) {
        new route53.ARecord(this, `AliasA${label}`, { zone: hostedZone, recordName, target });
        new route53.AaaaRecord(this, `AliasAaaa${label}`, { zone: hostedZone, recordName, target });
      }
    }

    const host = certificate ? (domainName ?? hostedZoneName) : distribution.distributionDomainName;
    new CfnOutput(this, "SiteUrl", { value: `https://${host}` });
    new CfnOutput(this, "ApiEndpoint", { value: `https://${host}/api/rp-signature` });
    new CfnOutput(this, "CloudFrontDomain", { value: distribution.distributionDomainName });
    new CfnOutput(this, "SiteBucketName", { value: site.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "SigningKeySecret", { value: signingKey.secretName });
    new CfnOutput(this, "SetSigningKeyCommand", {
      value:
        `aws secretsmanager put-secret-value --secret-id ${signingKey.secretName} ` +
        `--secret-string '0xYOUR_KEY' --region ${this.region}`,
    });
  }
}
