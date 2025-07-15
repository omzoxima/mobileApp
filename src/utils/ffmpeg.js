import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Convert a local MP4 (or any codec FFmpeg understands) to an HLS folder
 * in `outputDir`.  Returns the absolute path to the generated playlist.
 */
export function convertToHLS(inputPath, outputDir) {
  const playlistPath = path.join(outputDir, 'playlist.m3u8');

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-pix_fmt', 'yuv420p',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-start_number', '0',
        '-hls_time', '10',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        '-f', 'hls'
      ])
      .on('end', () => resolve(playlistPath))
      .on('error', reject)
      .save(playlistPath);
  });
}
