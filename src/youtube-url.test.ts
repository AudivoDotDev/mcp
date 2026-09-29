import { describe, expect, it } from 'vitest';
import { canonicalYoutubeUrl, youtubeVideoId } from './youtube-url.js';

describe('youtubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://youtube.com/watch?v=jNQXAC9IVRw&t=42s&list=PL123', 'jNQXAC9IVRw'],
    ['https://m.youtube.com/watch?v=jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://music.youtube.com/watch?v=jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://youtu.be/jNQXAC9IVRw?si=abc', 'jNQXAC9IVRw'],
    ['https://www.youtube.com/shorts/jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://www.youtube.com/live/jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://www.youtube.com/embed/jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['https://www.youtube-nocookie.com/embed/jNQXAC9IVRw', 'jNQXAC9IVRw'],
    ['http://www.youtube.com/watch?v=jNQXAC9IVRw', 'jNQXAC9IVRw'],
  ])('finds the id in %s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    'https://podcasts.apple.com/us/podcast/x/id123?i=456',
    'https://www.youtube.com/@acquiredfm',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw;rm',
    'https://evil.example/watch?v=jNQXAC9IVRw',
    'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw',
    'ftp://youtu.be/jNQXAC9IVRw',
    'not a url',
  ])('is not a video link: %s', (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });
});

describe('canonicalYoutubeUrl', () => {
  it('is the one form handed to yt-dlp', () => {
    expect(canonicalYoutubeUrl('jNQXAC9IVRw')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  });

  it('refuses anything that is not an id, so nothing else can reach the command line', () => {
    expect(() => canonicalYoutubeUrl('--exec=rm -rf /')).toThrow();
    expect(() => canonicalYoutubeUrl('jNQXAC9IVR')).toThrow();
  });
});
