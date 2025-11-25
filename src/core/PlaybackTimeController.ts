export class PlaybackTimeController {
    private _startCtxTime: number = 0;
    private _basePosition: number =0;
    private _rate: number = 1;
    private _loop: boolean = false 

    constructor(private getDuration: () => number) {}

    onStart(position:number = 0){
        this._basePosition = Math.max(0, position)
        this._startCtxTime = 0;
    }

    setStartCtxTime(ctxTime:number = 0 ){
        this._startCtxTime = ctxTime
    }

    pauseAt(ctxTime: number){
        const pos = this.compute(ctxTime)
        this._basePosition = Math.max(0, pos)
        this._startCtxTime = 0 
        return this._basePosition;
    }

    setRate(rate: number ){
        if(rate < 0 ) throw new RangeError("Playback rate must be positive")
        this._rate = rate 
    }

    setRatePlaying(ctxTime: number, newRate: number ){
        if(newRate < 0 ) throw new RangeError("Playback rate must be positive")
        
        const currentPos = this.compute(ctxTime)
        
        this._rate = newRate
        
        this._basePosition = Math.max(0, currentPos)
        
        this._startCtxTime = ctxTime 
    }

    getRate(){
        return this._rate
    }


    setLoop(loop:boolean){
        this._loop = loop
    }

    getLoop(){
        return this._loop
    }

    compute(ctxTime: number): number{
        if(!this._startCtxTime) return this._basePosition
        const elapsedReal = ctxTime - this._startCtxTime
        const elapsedTrack = elapsedReal * this._rate
        let time = this._basePosition + elapsedTrack

        const dur = this.getDuration()
        if(this._loop && dur >0 ){
            time = time % dur 
        }
        else if(dur > 0 ){
            time = Math.min(time, dur)
        }
        return time 
    }

    seek(seconds: number){
        this._basePosition = Math.max(0, Math.min(seconds, this.getDuration() || 0))
        if (this._startCtxTime !== 0) {
            this._startCtxTime = 0;
        }
    }



}