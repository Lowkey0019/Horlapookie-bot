import axios from 'axios';

const TXT2VIDEO_URL =
  'https://omegatech-api.dixonomega.tech/api/ai/Txt2video';

export async function createTxt2Video(prompt) {
  try {
    const response = await axios.get(TXT2VIDEO_URL, {
      params: { prompt },
      timeout: 60000,
      headers: {
        Accept: 'application/json',
      },
    });

    // 🔍 Optional debug
    // console.log(response.data);

    if (response.data?.success && response.data?.video_url) {
      return {
        success: true,
        videoUrl: response.data.video_url,
        provider: response.data.provider,
        message: response.data.message,
      };
    }

    return {
      success: false,
      error: 'Video not returned by API',
    };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
}

