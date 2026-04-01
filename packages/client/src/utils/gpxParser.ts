// packages/client/src/utils/gpxParser.ts

// Define max file size for GPX files (50MB)
const MAX_GPX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export async function parseGpxData(gpxContent: string, fileSize: number): Promise<any> {
  // Add file size gate
  if (fileSize > MAX_GPX_FILE_SIZE_BYTES) {
    throw new Error(`GPX file too large. Maximum allowed size is ${MAX_GPX_FILE_SIZE_BYTES / (1024 * 1024)}MB. Please upload a smaller file.`);
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxContent, 'application/xml');

    // Check for parsing errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      // For security, avoid echoing raw error message from browser DOMParser as it might contain sensitive paths
      // Instead, provide a generic user-friendly message.
      throw new Error('Failed to parse GPX data: Invalid XML format. Please check your GPX file.');
    }

    const gpxElement = doc.querySelector('gpx');
    if (!gpxElement) {
      throw new Error('Invalid GPX file: Missing root <gpx> element. Please ensure it is a valid GPX format.');
    }

    const tracks: any[] = [];
    doc.querySelectorAll('trk').forEach(trkElement => {
      const nameElement = trkElement.querySelector('name');
      const trackName = nameElement ? nameElement.textContent || 'Unnamed Track' : 'Unnamed Track';

      const segments: any[] = [];
      trkElement.querySelectorAll('trkseg').forEach(trksegElement => {
        const points: any[] = [];
        trksegElement.querySelectorAll('trkpt').forEach(trkptElement => {
          const lat = parseFloat(trkptElement.getAttribute('lat') || '0');
          const lon = parseFloat(trkptElement.getAttribute('lon') || '0');
          const eleElement = trkptElement.querySelector('ele');
          const ele = eleElement ? parseFloat(eleElement.textContent || '0') : 0;
          const timeElement = trkptElement.querySelector('time');
          const time = timeElement ? timeElement.textContent || '' : '';

          points.push({ lat, lon, ele, time });
        });
        segments.push({ points });
      });
      tracks.push({ name: trackName, segments });
    });

    return { tracks };

  } catch (error) {
    console.error('Error parsing GPX data:', error);
    // Re-throw the error with a generic message if it's not already user-friendly
    if (error instanceof Error) {
      throw error; // If it's an error we already created, re-throw it
    } else {
      throw new Error('An unexpected error occurred while parsing GPX data.');
    }
  }
}
