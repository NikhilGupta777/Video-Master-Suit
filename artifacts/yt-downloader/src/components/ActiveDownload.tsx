import { useEffect } from "react";
import { motion } from "framer-motion";
import { useGetDownloadProgress } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Download, Loader2, PlayCircle, CheckCircle2, AlertCircle } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

interface ActiveDownloadProps {
  jobId: string;
  onReset: () => void;
}

export function ActiveDownload({ jobId, onReset }: ActiveDownloadProps) {
  const { toast } = useToast();

  const { data: progress } = useGetDownloadProgress(jobId, {
    query: {
      enabled: !!jobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === 'pending' || status === 'downloading' || status === 'merging' ? 1000 : false;
      }
    }
  });

  const status = progress?.status || 'pending';
  const percent = progress?.percent || 0;

  useEffect(() => {
    if (status === 'error') {
      toast({
        title: "Download Failed",
        description: progress?.message || "An unexpected error occurred during processing.",
        variant: "destructive",
      });
    }
  }, [status, progress?.message, toast]);

  const isDone = status === 'done';
  const isError = status === 'error';
  const isProcessing = status === 'pending' || status === 'downloading' || status === 'merging';

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-3xl mx-auto mt-8 relative"
    >
      {/* Glow Effect behind card */}
      <div className={cn(
        "absolute -inset-1 rounded-3xl blur-xl opacity-20 transition-all duration-1000",
        isDone ? "bg-green-500 opacity-30" : isError ? "bg-red-600 opacity-40" : "bg-primary opacity-50"
      )} />
      
      <div className="glass-panel rounded-3xl p-8 md:p-12 relative overflow-hidden flex flex-col items-center text-center">
        
        {/* Status Icon */}
        <div className="mb-6">
          {isDone ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-green-500/20 p-4 rounded-full text-green-400">
              <CheckCircle2 className="w-12 h-12" />
            </motion.div>
          ) : isError ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-red-500/20 p-4 rounded-full text-red-400">
              <AlertCircle className="w-12 h-12" />
            </motion.div>
          ) : (
            <motion.div 
              animate={{ rotate: 360 }} 
              transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
              className="bg-primary/20 p-4 rounded-full text-primary"
            >
              <Loader2 className="w-12 h-12" />
            </motion.div>
          )}
        </div>

        {/* Status Text */}
        <h3 className="text-3xl font-display font-bold text-white mb-2">
          {status === 'pending' && "Initializing Job..."}
          {status === 'downloading' && "Downloading Video..."}
          {status === 'merging' && "Processing & Merging..."}
          {status === 'done' && "Ready to Save!"}
          {status === 'error' && "Processing Failed"}
        </h3>
        
        <p className="text-white/60 mb-10 max-w-md truncate">
          {progress?.filename || "Preparing your file, please wait..."}
        </p>

        {/* Progress Bar Area */}
        {isProcessing && (
          <div className="w-full max-w-md mx-auto mb-8">
            <div className="flex justify-between text-sm font-medium text-white/80 mb-3">
              <span>{progress?.speed || '-- MB/s'}</span>
              <span className="text-primary">{percent.toFixed(1)}%</span>
            </div>
            
            <div className="h-3 w-full bg-black/50 rounded-full overflow-hidden border border-white/10 shadow-inner relative">
              {status === 'merging' ? (
                <motion.div 
                  className="h-full bg-primary/50"
                  animate={{ x: ["-100%", "100%"] }}
                  transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                  style={{ width: "50%" }}
                />
              ) : (
                <motion.div 
                  className="h-full bg-gradient-to-r from-primary to-rose-400 relative"
                  initial={{ width: 0 }}
                  animate={{ width: `${percent}%` }}
                  transition={{ ease: "linear", duration: 0.5 }}
                >
                  <div className="absolute inset-0 bg-white/20 w-full animate-pulse" />
                </motion.div>
              )}
            </div>
            
            <div className="flex justify-between text-xs text-white/50 mt-3">
              <span>Size: {progress?.filesize ? formatBytes(progress.filesize) : 'Calculating...'}</span>
              <span>{progress?.eta ? `ETA: ${progress.eta}` : '--:--'}</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm justify-center">
          {isDone && (
            <Button asChild size="lg" className="w-full text-glow sm:w-auto shadow-[0_0_30px_rgba(229,9,20,0.4)]">
              <a href={`/api/youtube/file/${jobId}`} download>
                <Download className="w-5 h-5 mr-2" />
                Save File to Device
              </a>
            </Button>
          )}
          
          {(isDone || isError) && (
            <Button variant="outline" size="lg" onClick={onReset} className="w-full sm:w-auto">
              Download Another
            </Button>
          )}
        </div>

      </div>
    </motion.div>
  );
}
