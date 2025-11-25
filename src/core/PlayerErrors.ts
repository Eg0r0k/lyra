//TODO: Add PlayerErrors in Player;
export type ErrorType = 'network' | 'media' | 'decode' | 'config' | 'other'

export type ErrorCode = 
    // NETWORK ERRORS (1000-1999)
    1001 | // MANIFEST_LOAD_ERROR: Error loading file (fetch/URL)
    1002 | // TIMEOUT_ERROR: Timeout
    // MEDIA ERRORS (2000-2999)
    2001 | // NO_AUDIO_TRACK: AudioSteam not found in container (mediabunny)
    2002 | // EMPTY_AUDIO_DATA: AudioData is empty to decode
    
    // DECODE ERRORS (3000-3999)
    3001 | // DECODE_FAILED: Cant decode ArrayBuffer in AudioBuffer

    // OTHER ERRORS (9000-9999)
    9001; // INTERNAL_ERROR: Unexpected


export interface PlayerErrorData {
    type: ErrorType;
    code: ErrorCode;
    message: string;
    details?: any;
}