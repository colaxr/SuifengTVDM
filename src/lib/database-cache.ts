import { db } from './db';

// 格式化字节大小
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 获取存储类型
function getStorageType(): string {
  return process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
}

// 获取Redis兼容存储实例（支持KVRocks、Upstash、Redis）
function getRedisStorage(): any {
  try {
    // 安全地访问存储实例
    const storage = (db as any).storage;
    
    // 检查是否有Redis相关的方法
    if (storage && (
      typeof storage.client?.keys === 'function' || // 标准Redis客户端
      typeof storage.keys === 'function' // Upstash客户端
    )) {
      return storage;
    }
    
    console.warn('当前存储类型不支持缓存统计功能');
    return null;
  } catch (error) {
    console.warn('无法访问存储实例:', error);
    return null;
  }
}

// 数据库缓存统计和管理模块
export class DatabaseCacheManager {
  
  // 获取Redis兼容数据库中的缓存统计（支持KVRocks、Upstash、Redis）
  static async getKVRocksCacheStats() {
    console.log('🔍 开始获取Redis存储实例...');
    const storage = getRedisStorage();
    
    if (!storage) {
      console.warn('❌ Redis存储不可用，跳过数据库缓存统计');
      console.log('🔍 调试信息: storage =', storage);
      console.log('🔍 调试信息: db =', typeof db);
      console.log('🔍 调试信息: (db as any).storage =', typeof (db as any).storage);
      return null;
    }
    
    console.log('✅ Redis存储实例获取成功');
    console.log('🔍 存储类型检查: withRetry =', typeof storage.withRetry);
    console.log('🔍 存储类型检查: client.keys =', typeof storage.client?.keys);
    console.log('🔍 存储类型检查: keys =', typeof storage.keys);

    const stats = {
      douban: { count: 0, size: 0, types: {} as Record<string, number> },
      danmu: { count: 0, size: 0 },
      netdisk: { count: 0, size: 0 },
      total: { count: 0, size: 0 }
    };

    try {
      console.log('📊 开始从Redis兼容数据库读取缓存统计...');
      
      // 获取所有缓存键 - 根据存储类型分别处理
      let allCacheKeys: string[] = [];
      const storageType = getStorageType();
      
      console.log(`🔍 当前存储类型: ${storageType}`);
      
      if (storageType === 'upstash') {
        // Upstash Redis 直接调用
        console.log('🔍 使用Upstash Redis方式获取键...');
        if (typeof storage.keys === 'function') {
          allCacheKeys = await storage.keys('cache:*') as string[];
        } else {
          console.warn('❌ Upstash存储没有keys方法');
          return null;
        }
      } else if (storageType === 'kvrocks' || storageType === 'redis') {
        // KVRocks/标准Redis (带重试机制)
        console.log('🔍 使用KVRocks/标准Redis方式获取键...');
        if (typeof storage.withRetry === 'function' && storage.client?.keys) {
          allCacheKeys = await storage.withRetry(() => storage.client.keys('cache:*'));
        } else {
          console.warn('❌ KVRocks/Redis存储没有withRetry或client.keys方法');
          return null;
        }
      } else {
        console.warn('❌ 不支持的存储类型或无法找到合适的keys方法');
        console.log('🔍 存储类型:', storageType);
        console.log('🔍 可用方法:', Object.getOwnPropertyNames(storage));
        return null;
      }
      
      console.log(`📊 数据库中找到 ${allCacheKeys.length} 个缓存键:`, allCacheKeys.slice(0, 5));

      if (allCacheKeys.length === 0) {
        return stats;
      }

      // 批量获取所有缓存数据 - 根据存储类型分别处理
      let values: (string | null)[] = [];
      
      if (storageType === 'upstash') {
        // Upstash Redis 直接调用
        if (typeof storage.mget === 'function') {
          values = await storage.mget(allCacheKeys) as (string | null)[];
        } else {
          console.warn('Upstash没有mget方法，使用逐个获取');
          // 回退：逐个获取
          for (const key of allCacheKeys) {
            try {
              const value = await storage.get(key) as string | null;
              values.push(value);
            } catch (error) {
              console.warn(`获取缓存键 ${key} 失败:`, error);
              values.push(null);
            }
          }
        }
      } else if (storageType === 'kvrocks' || storageType === 'redis') {
        // KVRocks/标准Redis (带重试机制)
        if (typeof storage.withRetry === 'function' && storage.client?.mGet) {
          values = await storage.withRetry(() => storage.client.mGet(allCacheKeys));
        } else {
          console.warn('KVRocks/Redis没有mGet方法，使用逐个获取');
          // 回退：逐个获取
          for (const key of allCacheKeys) {
            try {
              let value: string | null = null;
              if (typeof storage.withRetry === 'function' && storage.client?.get) {
                value = await storage.withRetry(() => storage.client.get(key));
              }
              values.push(value);
            } catch (error) {
              console.warn(`获取缓存键 ${key} 失败:`, error);
              values.push(null);
            }
          }
        }
      } else {
        // 通用回退：逐个获取
        console.warn('使用通用回退方法逐个获取缓存数据');
        for (const key of allCacheKeys) {
          try {
            let value: string | null = null;
            if (typeof storage.get === 'function') {
              value = await storage.get(key) as string | null;
            }
            values.push(value);
          } catch (error) {
            console.warn(`获取缓存键 ${key} 失败:`, error);
            values.push(null);
          }
        }
      }
      
      allCacheKeys.forEach((fullKey: string, idx: number) => {
        const key = fullKey.replace('cache:', ''); // 移除前缀
        const data = values[idx];
        if (!data) return;
        
        const size = data.length;
        
        if (key.startsWith('douban-')) {
          stats.douban.count++;
          stats.douban.size += size;
          
          const type = key.split('-')[1];
          stats.douban.types[type] = (stats.douban.types[type] || 0) + 1;
        } 
        else if (key.startsWith('danmu-cache') || key === 'lunatv_danmu_cache') {
          stats.danmu.count++;
          stats.danmu.size += size;
        }
        else if (key.startsWith('netdisk-search')) {
          stats.netdisk.count++;
          stats.netdisk.size += size;
        }
        // 移除了search和other分类，只统计明确的缓存类型
        
        stats.total.count++;
        stats.total.size += size;
      });
      
      console.log(`✅ Redis缓存统计完成: 总计 ${stats.total.count} 项, ${formatBytes(stats.total.size)}`);
      return stats;
      
    } catch (error) {
      console.error('Redis缓存统计失败:', error);
      return null;
    }
  }

  // 获取缓存统计信息（优先Redis兼容数据库，备用localStorage）
  static async getSimpleCacheStats() {
    console.log('📊 开始获取缓存统计信息...');

    // 优先从 Redis兼容数据库 获取统计（支持KVRocks、Upstash、Redis）
    const redisStats = await DatabaseCacheManager.getKVRocksCacheStats();
    if (redisStats) {
      return {
        ...redisStats,
        timestamp: new Date().toISOString(),
        source: 'redis-database',
        note: '主要数据来源：Redis兼容数据库（KVRocks/Upstash/Redis）',
        formattedSizes: {
          douban: formatBytes(redisStats.douban.size),
          danmu: formatBytes(redisStats.danmu.size), 
          netdisk: formatBytes(redisStats.netdisk.size),
          total: formatBytes(redisStats.total.size)
        }
      };
    }

    // 如果 Redis数据库 不可用，使用 localStorage 作为备用
    const stats = {
      douban: { count: 0, size: 0, types: {} as Record<string, number> },
      danmu: { count: 0, size: 0 },
      netdisk: { count: 0, size: 0 },
      total: { count: 0, size: 0 }
    };

    // 从localStorage统计（备用数据源）
    if (typeof localStorage !== 'undefined') {
      const keys = Object.keys(localStorage).filter(key => 
        key.startsWith('douban-') || 
        key.startsWith('danmu-cache') || 
        key.startsWith('netdisk-search') ||
        key.startsWith('search-') || 
        key.startsWith('cache-') ||
        key === 'lunatv_danmu_cache'
      );
      
      console.log(`📊 localStorage中找到 ${keys.length} 个相关缓存键`);
      
      keys.forEach(key => {
        const data = localStorage.getItem(key);
        if (!data) return;
        
        const size = data.length;
        
        if (key.startsWith('douban-')) {
          stats.douban.count++;
          stats.douban.size += size;
          
          const type = key.split('-')[1];
          stats.douban.types[type] = (stats.douban.types[type] || 0) + 1;
        } 
        else if (key.startsWith('danmu-cache') || key === 'lunatv_danmu_cache') {
          stats.danmu.count++;
          stats.danmu.size += size;
        }
        else if (key.startsWith('netdisk-search')) {
          stats.netdisk.count++;
          stats.netdisk.size += size;
        }
        // 移除了search和other分类，只统计明确的缓存类型
        
        stats.total.count++;
        stats.total.size += size;
      });
    }

    return {
      ...stats,
      timestamp: new Date().toISOString(),
      source: 'localStorage-fallback',
      note: 'Redis数据库不可用，使用localStorage作为备用数据源',
      formattedSizes: {
        douban: formatBytes(stats.douban.size),
        danmu: formatBytes(stats.danmu.size), 
        netdisk: formatBytes(stats.netdisk.size),
        total: formatBytes(stats.total.size)
      }
    };
  }

  // 清理指定类型的缓存
  static async clearCacheByType(type: 'douban' | 'danmu' | 'netdisk'): Promise<number> {
    let clearedCount = 0;
    
    try {
      switch (type) {
        case 'douban':
          await db.clearExpiredCache('douban-');
          console.log('🗑️ 豆瓣缓存清理完成');
          break;
        case 'danmu':
          await db.clearExpiredCache('danmu-cache');
          console.log('🗑️ 弹幕缓存清理完成');
          break;
        case 'netdisk':
          await db.clearExpiredCache('netdisk-search');
          // 清理localStorage中的网盘缓存（兜底）
          if (typeof localStorage !== 'undefined') {
            const keys = Object.keys(localStorage).filter(key => 
              key.startsWith('netdisk-search')
            );
            keys.forEach(key => {
              localStorage.removeItem(key);
              clearedCount++;
            });
            console.log(`🗑️ localStorage中清理了 ${keys.length} 个网盘搜索缓存项`);
          }
          console.log('🗑️ 网盘搜索缓存清理完成');
          break;
      }
      
      // 由于clearExpiredCache不返回数量，我们无法精确统计
      clearedCount = 1; // 标记操作已执行
    } catch (error) {
      console.error(`清理${type}缓存失败:`, error);
    }

    return clearedCount;
  }

  // 清理所有过期缓存
  static async clearExpiredCache(): Promise<number> {
    try {
      await db.clearExpiredCache();
      console.log('🗑️ 所有过期缓存清理完成');
      return 1; // 标记操作已执行
    } catch (error) {
      console.error('清理过期缓存失败:', error);
      return 0;
    }
  }
}