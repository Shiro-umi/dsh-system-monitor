/*
 * dsh-system-monitor 的原生采样器。
 *
 * 每隔 N 毫秒（默认 50）往 stdout 写一行 JSON，字段：
 *   t  采样时刻（Unix 毫秒）
 *   n  逻辑核心数
 *   c  [user%, system%]，两次采样之间的 CPU 时间占比
 *   g  [device%, renderer%, tiler%]，GPU 利用率
 *   m  [used, wired, compressed, total]，内存（GiB，和 top 一致）
 *
 * 编译：clang -O2 sampler.c -framework IOKit -framework CoreFoundation -o bin/sampler
 * 宿主进程退出后（父进程 id 变化）或 stdout 写失败时自己退出。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/sysctl.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <IOKit/IOKitLib.h>
#include <CoreFoundation/CoreFoundation.h>

static mach_timebase_info_data_t tb;

static uint64_t ns_to_abs(uint64_t ns) { return ns * tb.denom / tb.numer; }

static void read_cpu(uint64_t *user, uint64_t *sys, uint64_t *total, natural_t *ncpu) {
  processor_info_array_t info;
  mach_msg_type_number_t count;
  if (host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, ncpu, &info, &count) != KERN_SUCCESS) {
    *user = *sys = *total = 0;
    return;
  }
  processor_cpu_load_info_t load = (processor_cpu_load_info_t)info;
  uint64_t u = 0, s = 0, t = 0;
  for (natural_t i = 0; i < *ncpu; i++) {
    uint64_t cu = load[i].cpu_ticks[CPU_STATE_USER] + load[i].cpu_ticks[CPU_STATE_NICE];
    uint64_t cs = load[i].cpu_ticks[CPU_STATE_SYSTEM];
    uint64_t ci = load[i].cpu_ticks[CPU_STATE_IDLE];
    u += cu;
    s += cs;
    t += cu + cs + ci;
  }
  vm_deallocate(mach_task_self(), (vm_address_t)info, count * sizeof(int));
  *user = u;
  *sys = s;
  *total = t;
}

/* 与 top 的 PhysMem 一致：used = 总页数 - 空闲页，单位 GiB。 */
static void read_mem(double total_bytes, double *used, double *wired, double *comp) {
  vm_statistics64_data_t vm;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  vm_size_t page = 0;
  host_page_size(mach_host_self(), &page);
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &count) != KERN_SUCCESS) {
    *used = *wired = *comp = 0;
    return;
  }
  const double gib = 1073741824.0;
  *used = (total_bytes - (double)vm.free_count * page) / gib;
  *wired = (double)vm.wire_count * page / gib;
  *comp = (double)vm.compressor_page_count * page / gib;
}

static double ps_num(CFDictionaryRef ps, CFStringRef key) {
  CFNumberRef n = ps ? CFDictionaryGetValue(ps, key) : NULL;
  double v = 0;
  if (n) CFNumberGetValue(n, kCFNumberDoubleType, &v);
  return v;
}

int main(int argc, char **argv) {
  int interval_ms = argc > 1 ? atoi(argv[1]) : 50;
  if (interval_ms < 10) interval_ms = 10;
  signal(SIGPIPE, SIG_IGN);
  mach_timebase_info(&tb);
  pid_t parent = getppid();

  uint64_t memsize = 0;
  size_t len = sizeof(memsize);
  sysctlbyname("hw.memsize", &memsize, &len, NULL, 0);
  double mem_total = (double)memsize / 1073741824.0;

  io_iterator_t it = IO_OBJECT_NULL;
  io_service_t gpu = IO_OBJECT_NULL;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &it) == KERN_SUCCESS) {
    gpu = IOIteratorNext(it);
  }

  natural_t ncpu = 0;
  uint64_t u0, s0, t0;
  read_cpu(&u0, &s0, &t0, &ncpu);

  uint64_t step = ns_to_abs((uint64_t)interval_ms * 1000000ull);
  uint64_t next = mach_absolute_time() + step;

  for (;;) {
    mach_wait_until(next);
    next += step;
    uint64_t now = mach_absolute_time();
    if (next < now) next = now + step; /* 被挂起后不补发 */
    if (getppid() != parent) return 0;

    uint64_t u1, s1, t1;
    read_cpu(&u1, &s1, &t1, &ncpu);
    double dt = (double)(t1 - t0);
    double cu = dt > 0 ? 100.0 * (double)(u1 - u0) / dt : 0;
    double cs = dt > 0 ? 100.0 * (double)(s1 - s0) / dt : 0;
    u0 = u1; s0 = s1; t0 = t1;

    double mu, mw, mc;
    read_mem((double)memsize, &mu, &mw, &mc);

    double gd = 0, gr = 0, gt = 0;
    if (gpu != IO_OBJECT_NULL) {
      CFDictionaryRef ps = IORegistryEntryCreateCFProperty(gpu, CFSTR("PerformanceStatistics"), kCFAllocatorDefault, 0);
      if (ps) {
        gd = ps_num(ps, CFSTR("Device Utilization %"));
        gr = ps_num(ps, CFSTR("Renderer Utilization %"));
        gt = ps_num(ps, CFSTR("Tiler Utilization %"));
        CFRelease(ps);
      }
    }

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    char buf[256];
    int n = snprintf(buf, sizeof buf,
      "{\"t\":%lld,\"n\":%u,\"c\":[%.1f,%.1f],\"g\":[%.0f,%.0f,%.0f],\"m\":[%.3f,%.3f,%.3f,%.3f]}\n",
      (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000, ncpu, cu, cs, gd, gr, gt, mu, mw, mc, mem_total);
    if (write(1, buf, (size_t)n) < 0) return 0;
  }
}