import http from "http"
import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Transform, Writable } from "stream"
import zlib from "zlib"
import { FetchCallback } from './types'

import './globals'

export const getRequestListener = (fetchCallback: FetchCallback) => {
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const method = incoming.method || 'GET'
    const url = `http://${incoming.headers.host}${incoming.url}`

    const headerRecord: [string, string][] = []
    const len = incoming.rawHeaders.length
    for (let i = 0; i < len; i += 2) {
      headerRecord.push([incoming.rawHeaders[i], incoming.rawHeaders[i + 1]])
    }

    const init = {
      method: method,
      headers: headerRecord,
    } as RequestInit

    if (!(method === 'GET' || method === 'HEAD')) {
      // lazy-consume request body
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>
      // node 18 fetch needs half duplex mode when request body is stream
      ;(init as any).duplex = 'half'
    }

    let res: Response

    try {
      res = (await fetchCallback(new Request(url.toString(), init))) as Response
    } catch (e: unknown) {
      res = new Response(null, { status: 500 })
      if (e instanceof Error) {
        // timeout error emits 504 timeout
        if (e.name === 'TimeoutError' || e.constructor.name === 'TimeoutError') {
          res = new Response(null, { status: 504 })
        } else {
          res = new Response(e.stack, { status: 500 })
        }
      }
    }

    try {
      await writeResponse(res, outgoing)
    } catch (e: unknown) {
      // try to catch any error, to avoid crash
      console.error(e)
      const err = e instanceof Error ? e : new Error('unknown error', { cause: e })
      // destroy error must accept an instance of Error
      outgoing.destroy(err)
          // Otherwise, send plaintext stack trace
      outgoing?.writeHead(500, { "Content-Type": "text/plain; charset=UTF-8" });
      outgoing?.end(err.stack, "utf8");
    }
  }
}

// https://github.com/cloudflare/miniflare/blob/7e4d906e19cc69cd3446512bfeb7f8aee3a2bda7/packages/http-server/src/index.ts#L135
async function writeResponse(
  response: Response,
  res: http.ServerResponse,
) {
  const headers: http.OutgoingHttpHeaders = {};
  // eslint-disable-next-line prefer-const
  for (let [key, value] of response.headers) {
    key = key.toLowerCase();
    if (key === "set-cookie") {
      // Multiple Set-Cookie headers should be treated as separate headers
      // @ts-expect-error getAll is added to the Headers prototype by
      // importing @miniflare/core
      headers["set-cookie"] = response.headers.getAll("set-cookie");
    } else if (key !== "content-length") {
      // Content-Length has special handling below
      headers[key] = value;
    }
  }

  // Use body's actual length instead of the Content-Length header if set,
  // see https://github.com/cloudflare/miniflare/issues/148. We also might
  // need to adjust this later for live reloading so hold onto it.
  const contentLengthHeader = response.headers.get("Content-Length");
  const contentLength = (contentLengthHeader === null ? null : parseInt(contentLengthHeader));
  if (contentLength !== null && !isNaN(contentLength)) {
    headers["content-length"] = contentLength;
  }

  // If a Content-Encoding is set, and the user hasn't encoded the body,
  // we're responsible for doing so.
  const encoders: Transform[] = [];
  if (headers["content-encoding"]) {
    // Reverse of https://github.com/nodejs/undici/blob/48d9578f431cbbd6e74f77455ba92184f57096cf/lib/fetch/index.js#L1660
    const codings = headers["content-encoding"]
      .toString()
      .toLowerCase()
      .split(",")
      .map((x) => x.trim());
    for (const coding of codings) {
      if (/(x-)?gzip/.test(coding)) {
        encoders.push(zlib.createGzip());
      } else if (/(x-)?deflate/.test(coding)) {
        encoders.push(zlib.createDeflate());
      } else if (coding === "br") {
        encoders.push(zlib.createBrotliCompress());
      } else {
        // Unknown encoding, don't do any encoding at all
        encoders.length = 0;
        break;
      }
    }
    if (encoders.length > 0) {
      // Content-Length will be wrong as it's for the decoded length
      delete headers["content-length"];
    }
  }

  res.writeHead(response.status, headers);

  // `initialStream` is the stream we'll write the response to. It
  // should end up as the first encoder, piping to the next encoder,
  // and finally piping to the response:
  //
  // encoders[0] (initialStream) -> encoders[1] -> res
  //
  // Not using `pipeline(passThrough, ...encoders, res)` here as that
  // gives a premature close error with server sent events. This also
  // avoids creating an extra stream even when we're not encoding.
  let initialStream: Writable = res;
  for (let i = encoders.length - 1; i >= 0; i--) {
    encoders[i].pipe(initialStream);
    initialStream = encoders[i];
  }

  // Response body may be null if empty
  if (response.body) {
    // @ts-ignore
    for await (const chunk of response.body) {
      if (chunk) initialStream.write(chunk);
    }
  }

  initialStream.end();
}
