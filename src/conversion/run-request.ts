import {
  conversionCancelled,
  convertConversionRequestAsync,
  createConversionRequest,
  type ConversionCancellation,
  type ConversionRasterRequestMessage,
  type ConversionRequestMessage,
  type ConversionResultMessage
} from './image-to-pattern';
import { rasterForConversion } from './raster';

/**
 * Runs one conversion request: an image request is decoded and rasterized
 * within its own `maxBytes`/`maxPixels` first. The worker and the main-thread
 * fallback both run this, so they cannot drift apart.
 */
export async function runConversionRequest(request: ConversionRequestMessage, cancellation: ConversionCancellation): Promise<ConversionResultMessage> {
  const { requestId } = request.token;
  conversionCancelled(cancellation, requestId);
  let rasterRequest: ConversionRasterRequestMessage;
  if (request.inputType === 'raster') {
    rasterRequest = request;
  } else {
    const raster = await rasterForConversion(request.image, request.targetWidth, request.targetHeight, { maxBytes: request.maxBytes, maxPixels: request.maxPixels }, cancellation);
    conversionCancelled(cancellation, requestId);
    rasterRequest = createConversionRequest(raster, {
      targetWidth: request.targetWidth,
      targetHeight: request.targetHeight,
      paletteBudget: request.paletteBudget,
      backgroundSourceId: request.backgroundSourceId,
      autoCrop: request.autoCrop,
      confettiDistance: request.confettiDistance,
      catalog: request.catalog,
      token: request.token,
      sourceImage: {
        ...(request.sourceAssetId === undefined ? {} : { assetId: request.sourceAssetId }),
        ...(request.sourceMimeType === undefined ? {} : { mimeType: request.sourceMimeType })
      }
    });
  }
  const result = await convertConversionRequestAsync(rasterRequest, cancellation);
  conversionCancelled(cancellation, requestId);
  return result;
}
