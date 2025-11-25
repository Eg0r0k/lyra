import { EQ } from "./EQ"


export class AudioGraph {
    public readonly input: GainNode
    public readonly finalOutput: GainNode 
    public eq: EQ

    private eqBypassed = false;

    constructor(private ctx: AudioContext){

        this.input = ctx.createGain()
        this.finalOutput = ctx.createGain()
        this.eq = new EQ(ctx)

        // chain: input -> EQ -> finalOutput -> destination
        this.input.connect(this.eq.input)
        this.eq.output.connect(this.finalOutput)
        this.finalOutput.connect(this.ctx.destination)
    }

    
    getVolume(){
        return this.input.gain.value
    }

    setVoulme(v: number ){
        this.input.gain.value = v
    }

    bypassEQ(enabled: boolean){
        if (enabled === this.eqBypassed) return;        
        this.eqBypassed=  enabled

        this.input.disconnect();
        if(enabled){
            this.input.connect(this.finalOutput)
        }
        else{
            this.input.connect(this.eq.input);
            this.eq.output.connect(this.finalOutput)
        }
    }


    dispose() {
try {
this.input.disconnect();
} catch {}
try {
this.eq.output.disconnect();
} catch {}
try {
this.finalOutput.disconnect();
} catch {}
}

}