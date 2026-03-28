import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Youtube, Search, ArrowRight, Play, Clock, Eye, Film, Music, Download, Loader2 } from "lucide-react";
import { useGetVideoInfo, useDownloadVideo } from "@workspace/api-client-react";
import type { VideoFormat } from "@workspace/api-client-react";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes, formatDuration, formatViews } from "@/lib/utils";
import { ActiveDownload } from "@/components/ActiveDownload";

export default function Home() {
  const [url, setUrl] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeFormatId, setActiveFormatId] = useState<string | null>(null);
  const { toast } = useToast();

  const getInfo = useGetVideoInfo({
    mutation: {
      onSuccess: () => {
        setJobId(null);
        setActiveFormatId(null);
      },
      onError: (error) => {
        toast({
          title: "Couldn't fetch video",
          description: error.error?.error || "Please check the URL and try again.",
          variant: "destructive",
        });
      }
    }
  });

  const download = useDownloadVideo({
    mutation: {
      onSuccess: (data) => {
        setJobId(data.jobId);
      },
      onError: (error) => {
        toast({
          title: "Download Failed",
          description: error.error?.error || "Could not start the download process.",
          variant: "destructive",
        });
        setActiveFormatId(null);
      }
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    getInfo.mutate({ data: { url } });
  };

  const handleDownload = (format: VideoFormat) => {
    setActiveFormatId(format.formatId);
    download.mutate({ 
      data: { 
        url, 
        formatId: format.formatId, 
        audioOnly: !format.hasVideo 
      } 
    });
  };

  const video = getInfo.data;
  
  // Sort and group formats safely
  const videoFormats = video?.formats?.filter(f => f.hasVideo && f.hasAudio)?.sort((a, b) => {
    const resA = parseInt(a.resolution?.split('x')[1] || '0');
    const resB = parseInt(b.resolution?.split('x')[1] || '0');
    if (resB !== resA) return resB - resA;
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  const audioFormats = video?.formats?.filter(f => !f.hasVideo && f.hasAudio)?.sort((a, b) => {
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  return (
    <div className="min-h-screen relative overflow-x-hidden flex flex-col items-center pb-24 px-4 sm:px-6">
      
      {/* Premium Background */}
      <div className="fixed inset-0 z-[-1]">
        <img 
          src={`${import.meta.env.BASE_URL}images/dark-glow-bg.png`} 
          alt="Dark premium abstract background" 
          className="w-full h-full object-cover opacity-50 mix-blend-screen"
        />
        <div className="absolute inset-0 bg-background/80 backdrop-blur-[60px]" />
        {/* Subtle top glow */}
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
      </div>

      <main className="w-full max-w-5xl mx-auto flex flex-col items-center z-10 relative">
        
        {/* Animated Container for Hero / Search */}
        <motion.div 
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "w-full flex flex-col items-center transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
            video ? "pt-12 mb-12" : "pt-[25vh]"
          )}
        >
          <motion.div layout className="flex items-center gap-3 mb-8">
            <div className="bg-primary/20 p-3 rounded-2xl border border-primary/30 shadow-[0_0_30px_rgba(229,9,20,0.3)]">
              <Youtube className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl md:text-5xl font-display font-bold tracking-tight text-white">
              YT<span className="text-primary text-glow">Grabber</span>
            </h1>
          </motion.div>

          {!video && (
            <motion.p layout className="text-white/60 text-lg mb-8 text-center max-w-lg">
              Download high-quality videos and audio instantly. Paste any YouTube link below to get started.
            </motion.p>
          )}

          <motion.form 
            layout 
            onSubmit={handleSearch}
            className="w-full max-w-2xl relative group"
          >
            <div className="absolute -inset-1 bg-gradient-to-r from-primary/60 to-purple-600/60 rounded-2xl blur-lg opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none" />
            <div className="relative glass-panel rounded-2xl flex p-2 shadow-2xl items-center focus-within:border-primary/50 transition-colors">
              <Search className="w-6 h-6 text-white/40 ml-4 hidden sm:block" />
              <input 
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="bg-transparent flex-1 outline-none px-4 py-3 text-white placeholder:text-white/30 text-lg"
                autoFocus
              />
              <Button 
                type="submit" 
                size="lg"
                disabled={getInfo.isPending || !url.trim()}
                className="h-12 px-6 rounded-xl shrink-0"
              >
                {getInfo.isPending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    Fetching
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    Start <ArrowRight className="w-5 h-5" />
                  </span>
                )}
              </Button>
            </div>
          </motion.form>
        </motion.div>

        {/* Video Results Area */}
        <AnimatePresence mode="wait">
          {video && !jobId && (
            <motion.div 
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="w-full flex flex-col gap-8"
            >
              {/* Video Info Card */}
              <div className="glass-panel p-4 sm:p-6 rounded-3xl flex flex-col md:flex-row gap-6 sm:gap-8 items-center md:items-start group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 blur-[80px] rounded-full pointer-events-none" />
                
                <div className="relative w-full md:w-80 shrink-0 aspect-video rounded-2xl overflow-hidden shadow-2xl border border-white/10 group-hover:border-primary/30 transition-colors">
                  <img src={video.thumbnail || ''} alt={video.title} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/30 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                    <div className="bg-black/50 backdrop-blur-md p-3 rounded-full text-white/90 group-hover:text-white group-hover:scale-110 transition-all shadow-lg">
                      <Play className="w-8 h-8 ml-1" />
                    </div>
                  </div>
                  <div className="absolute bottom-2 right-2 bg-black/80 backdrop-blur-md text-white text-xs font-semibold px-2 py-1 rounded-md flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDuration(video.duration)}
                  </div>
                </div>

                <div className="flex flex-col flex-1 w-full justify-center h-full min-h-[180px]">
                  <h2 className="text-2xl sm:text-3xl font-display font-bold text-white leading-tight mb-4">
                    {video.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-white/70">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-700 to-gray-900 border border-white/10 flex items-center justify-center font-bold text-xs text-white uppercase shadow-inner">
                        {video.uploader?.charAt(0) || 'Y'}
                      </div>
                      <span className="font-medium text-white/90">{video.uploader}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Eye className="w-4 h-4 text-white/40" />
                      {formatViews(video.viewCount)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Formats Grid */}
              <div className="space-y-8">
                
                {/* Video Options */}
                {videoFormats.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 px-2">
                      <Film className="w-5 h-5 text-primary" />
                      <h3 className="text-xl font-display font-semibold text-white">Video Options</h3>
                      <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent ml-4" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {videoFormats.map((format, idx) => (
                        <FormatCard 
                          key={format.formatId} 
                          format={format} 
                          isBest={idx === 0} 
                          onDownload={handleDownload}
                          isPending={activeFormatId === format.formatId && download.isPending}
                          isDisabled={download.isPending}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Audio Options */}
                {audioFormats.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 px-2">
                      <Music className="w-5 h-5 text-purple-400" />
                      <h3 className="text-xl font-display font-semibold text-white">Audio Only</h3>
                      <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent ml-4" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {audioFormats.slice(0, 6).map((format, idx) => (
                        <FormatCard 
                          key={format.formatId} 
                          format={format} 
                          isBest={idx === 0} 
                          onDownload={handleDownload}
                          isPending={activeFormatId === format.formatId && download.isPending}
                          isDisabled={download.isPending}
                          audioOnly
                        />
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Active Download Progress */}
        <AnimatePresence>
          {jobId && (
            <ActiveDownload 
              jobId={jobId} 
              onReset={() => {
                setJobId(null);
                setActiveFormatId(null);
              }} 
            />
          )}
        </AnimatePresence>

      </main>
    </div>
  );
}

// Sub-component for individual format cards
function FormatCard({ 
  format, 
  isBest, 
  onDownload, 
  isPending, 
  isDisabled,
  audioOnly = false
}: { 
  format: VideoFormat; 
  isBest: boolean; 
  onDownload: (f: VideoFormat) => void;
  isPending: boolean;
  isDisabled: boolean;
  audioOnly?: boolean;
}) {
  return (
    <div className="group relative glass-panel hover:bg-white/10 border-white/5 hover:border-primary/40 transition-all duration-300 rounded-2xl p-5 overflow-hidden flex flex-col justify-between">
      {/* Hover gradient sweep */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      
      <div className="relative z-10 flex justify-between items-start mb-4">
        <div>
          <span className="font-display font-bold text-2xl text-white tracking-tight">
            {format.quality}
          </span>
          <div className="flex items-center gap-2 text-sm text-white/50 mt-1">
            <span className="uppercase font-medium tracking-wide">{format.ext}</span>
            <span className="w-1 h-1 rounded-full bg-white/20" />
            <span>{format.vcodec !== 'none' ? format.vcodec?.split('.')[0] : format.acodec?.split('.')[0] || 'Unknown'}</span>
          </div>
        </div>
        
        {isBest && (
          <Badge className={audioOnly ? "bg-purple-500/20 text-purple-300 border-purple-500/30" : "bg-primary/20 text-red-300 border-primary/30"}>
            Best Quality
          </Badge>
        )}
      </div>

      <div className="relative z-10 flex items-center justify-between mt-2">
        <span className="text-white/80 font-medium text-sm">
          {formatBytes(format.filesize)}
        </span>
        
        <Button 
          size="sm" 
          variant={isBest ? "default" : "glass"}
          onClick={() => onDownload(format)}
          disabled={isDisabled}
          className={cn(
            "rounded-lg px-4",
            !isBest && "bg-white/10 hover:bg-white/20 border-transparent shadow-none"
          )}
        >
          {isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>Get <Download className="w-4 h-4 ml-2 opacity-70 group-hover:opacity-100 group-hover:-translate-y-0.5 transition-all" /></>
          )}
        </Button>
      </div>
    </div>
  );
}
